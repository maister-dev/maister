import type { FrameAdmission } from "./producer-pressure";
import type {
  AnyMessage,
  Client,
  Stream,
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk";
import type { WriteStream } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import type {
  Readable as NodeReadable,
  Writable as NodeWritable,
} from "node:stream";

import { randomUUID } from "node:crypto";
import { open, unlink } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import { ReadableStream, WritableStream } from "node:stream/web";
import { setImmediate as nextTurn } from "node:timers/promises";

import {
  zRequestPermissionRequest,
  zSessionNotification,
} from "@agentclientprotocol/sdk/dist/schema/zod.gen.js";

import { SupervisorError, type SupervisorErrorDetails } from "./types";

export const MAX_ACP_FRAME_BYTES = 1_048_576;
const MAX_PRODUCERS = 20;
const PRODUCER_BUFFER_BYTES = 144 * 1024;
const DECODE_BUFFER_BYTES = 7 * 1024 * 1024;

// One decoder/publication slot plus twenty bounded pipe/chunk/ring reservations fits
// below 10 MiB. Partial lines live on disk and never hold the decoder permit.
let producers = 0;
let retainedBytes = 0;
let decoding = false;
const decodeWaiters: Array<() => void> = [];

export function reserveOutputProducer(): () => void {
  if (
    producers >= MAX_PRODUCERS ||
    DECODE_BUFFER_BYTES +
      (producers + 1) * PRODUCER_BUFFER_BYTES +
      retainedBytes >
      10 * 1024 * 1024
  ) {
    throw new SupervisorError(
      "EXECUTOR_UNAVAILABLE",
      "host output buffer capacity is exhausted",
      {
        details: { reason: "runtime_output_buffer_capacity" },
      },
    );
  }
  producers += 1;
  let released = false;

  return () => {
    if (released) return;
    released = true;
    producers -= 1;
  };
}

export function outputBufferStats(): {
  producers: number;
  reservedBytes: number;
  decoderQueued: number;
} {
  return {
    producers,
    reservedBytes:
      producers * PRODUCER_BUFFER_BYTES +
      retainedBytes +
      (decoding ? DECODE_BUFFER_BYTES : 0),
    decoderQueued: decodeWaiters.length,
  };
}

/** Accounts for a bounded accumulated reply until its reference is durable. */
export function retainedOutputBudget(): {
  reserve: (bytes: number) => void;
  release: () => void;
} {
  let owned = 0;

  return {
    reserve(bytes) {
      if (
        !Number.isSafeInteger(bytes) ||
        bytes < 0 ||
        owned + bytes > 2 * 1024 * 1024 ||
        DECODE_BUFFER_BYTES +
          producers * PRODUCER_BUFFER_BYTES +
          retainedBytes +
          bytes >
          10 * 1024 * 1024
      ) {
        throw incomplete("producer_retained_limit");
      }
      owned += bytes;
      retainedBytes += bytes;
    },
    release() {
      retainedBytes -= owned;
      owned = 0;
    },
  };
}

export type BoundedAcpClient = Client & {
  requestPermission(
    params: RequestPermissionRequest,
    onPrepared?: () => void,
  ): Promise<RequestPermissionResponse>;
};

async function acquireDecoder(): Promise<() => void> {
  if (decoding)
    await new Promise<void>((resolve) => decodeWaiters.push(resolve));
  else decoding = true;

  return () => {
    const next = decodeWaiters.shift();

    if (next) next();
    else decoding = false;
  };
}

function incomplete(
  outputFailure: NonNullable<SupervisorErrorDetails["outputFailure"]>,
): SupervisorError {
  return new SupervisorError(
    "ACP_PROTOCOL",
    "ACP output could not be preserved completely",
    {
      details: {
        reason:
          outputFailure === "producer_frame_limit"
            ? "runtime_output_frame_too_large"
            : "required_output_incomplete",
        outputFailure,
      },
    },
  );
}

function writeChunk(stream: NodeWritable, bytes: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) =>
    stream.write(bytes, (error) => (error ? reject(error) : resolve())),
  );
}

function waitReadable(source: NodeReadable): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      source.off("readable", ready);
      source.off("end", ready);
      source.off("error", failed);
      source.off("close", ready);
    };
    const ready = (): void => {
      cleanup();
      resolve();
    };
    const failed = (error: Error): void => {
      cleanup();
      reject(error);
    };

    source.once("readable", ready);
    source.once("end", ready);
    source.once("error", failed);
    source.once("close", ready);
    if (source.readableLength > 0 || source.readableEnded || source.destroyed)
      ready();
  });
}

async function* boundedChunks(source: NodeReadable): AsyncGenerator<Buffer> {
  for (;;) {
    if (source.readableLength > 0) {
      const chunk: unknown = source.read(
        Math.min(source.readableLength, 65_536),
      );

      if (!Buffer.isBuffer(chunk)) throw incomplete("producer_chunk_limit");
      yield chunk;
    } else if (source.errored) {
      throw source.errored;
    } else if (source.readableEnded || source.destroyed) {
      return;
    } else {
      await waitReadable(source);
    }
  }
}

async function readCapturedFrame(
  spool: FileHandle,
  length: number,
): Promise<Buffer> {
  const frame = Buffer.allocUnsafe(length);
  let read = 0;

  while (read < length) {
    const result = await spool.read(frame, read, length - read, read);

    if (result.bytesRead === 0) throw incomplete("producer_spool_incomplete");
    read += result.bytesRead;
  }

  return frame;
}

function publishCapturedFrame(
  frame: Uint8Array,
  onLine: (line: string) => void,
): void {
  onLine(
    new TextDecoder("utf-8", { fatal: true }).decode(frame.subarray(0, -1)),
  );
}

export type CapturedStdoutSegment = {
  descriptor: number;
  sizeBytes: number;
  firstLogByteOffset: number;
  completeFrames: number;
  trailingFrameBytes: number;
};

/** Retains at most one input chunk; a partial frame is an exclusive disk spool. */
export function captureAcpFrames(input: {
  source: NodeReadable;
  directory: string;
  log: WriteStream;
  onLine: (line: string) => void;
  onFailure: (error: SupervisorError) => void;
  onDrained: () => void;
  onStorageFailure?: (error: unknown) => void;
  storageAvailable?: () => boolean;
  beforeFrame?: () => Promise<FrameAdmission>;
  shouldDrain?: () => boolean;
  onSegment?: (segment: CapturedStdoutSegment) => void;
}): NodeReadable {
  input.log.once("error", (error) => {
    input.onStorageFailure?.(error);
    input.onFailure(incomplete("producer_output_storage"));
  });
  async function* frames(): AsyncGenerator<Buffer> {
    const temporary = join(input.directory, `.acp-frame-${randomUUID()}.tmp`);
    let spool: FileHandle | null = null;
    let length = 0;
    let firstLogByteOffset = 0;
    let draining = false;
    let segmentPublished = false;
    let completeFrames = 0;
    let trailingFrameBytes = 0;
    const publishSegment = (): void => {
      if (!draining || segmentPublished || length === 0 || !spool) return;
      if (!input.onSegment) throw incomplete("producer_output_incomplete");
      input.onSegment({
        descriptor: spool.fd,
        sizeBytes: length,
        firstLogByteOffset,
        completeFrames,
        trailingFrameBytes,
      });
      segmentPublished = true;
    };

    try {
      spool = await open(temporary, "wx+", 0o600);
      for await (const chunk of boundedChunks(input.source)) {
        if (!(chunk instanceof Uint8Array) || chunk.byteLength > 65_536)
          throw incomplete("producer_chunk_limit");
        let offset = 0;

        while (offset < chunk.byteLength) {
          const newline = chunk.indexOf(10, offset);
          const end = newline === -1 ? chunk.byteLength : newline + 1;
          const part = chunk.subarray(offset, end);

          if (
            length + part.byteLength >
            (draining ? 2_097_152 : MAX_ACP_FRAME_BYTES)
          )
            throw incomplete("producer_frame_limit");
          let written = 0;

          while (written < part.byteLength) {
            const result = await spool.write(
              part,
              written,
              part.byteLength - written,
              length + written,
            );

            if (result.bytesWritten === 0)
              throw incomplete("producer_output_storage");
            written += result.bytesWritten;
          }
          await writeChunk(input.log, part);
          length += part.byteLength;
          offset = end;
          trailingFrameBytes += part.byteLength;
          if (newline === -1) continue;
          completeFrames += 1;
          trailingFrameBytes = 0;
          if (draining) continue;
          const admission = input.beforeFrame
            ? await input.beforeFrame()
            : undefined;

          if (admission?.kind === "drain") {
            draining = true;
            continue;
          }
          const release = await acquireDecoder();

          let frame: Buffer | null = null;

          try {
            frame = await readCapturedFrame(spool, length);
            publishCapturedFrame(frame, input.onLine);
            yield frame;
          } finally {
            // Async-generator registers otherwise retain the last yielded frame
            // while waiting for another producer's decoder slot.
            frame = null;
            release();
            admission?.release();
          }
          firstLogByteOffset += length;
          length = 0;
          completeFrames = 0;
          await spool.truncate(0);
        }
      }
      if (length !== 0 && input.shouldDrain?.()) draining = true;
      if (draining) {
        publishSegment();
        throw incomplete("producer_output_incomplete");
      }
      if (length !== 0) throw incomplete("producer_frame_incomplete");
    } catch (error) {
      input.onStorageFailure?.(error);
      // Even an over-budget or truncated drain preserves its captured prefix
      // before the typed failure and terminal barrier become observable.
      let failure =
        error instanceof SupervisorError
          ? error
          : incomplete("producer_output_storage");

      try {
        publishSegment();
      } catch (error) {
        input.onStorageFailure?.(error);
        failure = incomplete("producer_output_storage");
      }
      input.onFailure(failure);
      throw failure;
    } finally {
      try {
        if (spool) {
          await spool.close();
          if (input.storageAvailable?.() !== false) await unlink(temporary);
        }
      } catch (error) {
        input.onStorageFailure?.(error);
        throw error;
      } finally {
        const flushed = finished(input.log);

        input.log.end();
        try {
          await flushed;
        } finally {
          input.onDrained();
        }
      }
    }
  }

  return Readable.from(frames(), { objectMode: true, highWaterMark: 0 });
}

/** Bounds JSON parser work before allocating the decoded object graph. */
function parseFrame(frame: Uint8Array): AnyMessage {
  if (frame.byteLength > MAX_ACP_FRAME_BYTES)
    throw incomplete("producer_frame_limit");
  let quoted = false;
  let escaped = false;
  let depth = 0;
  let structures = 0;

  for (const byte of frame) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (byte === 92) escaped = true;
      else if (byte === 34) quoted = false;
      continue;
    }
    if (byte === 34) quoted = true;
    if (byte === 123 || byte === 91) depth += 1;
    if (byte === 125 || byte === 93) depth -= 1;
    if (byte === 123 || byte === 91 || byte === 44 || byte === 58)
      structures += 1;
    if (depth > 32 || structures > 8192)
      throw incomplete("producer_json_complexity");
  }
  let value: unknown;

  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(frame));
  } catch {
    throw incomplete("producer_frame_invalid");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw incomplete("producer_frame_invalid");
  const message = value as Record<string, unknown>;
  const validId =
    message.id === null ||
    (typeof message.id === "string" && Buffer.byteLength(message.id) <= 128) ||
    (typeof message.id === "number" && Number.isSafeInteger(message.id));

  if (
    message.jsonrpc !== "2.0" ||
    ("id" in message && !validId) ||
    ("method" in message
      ? typeof message.method !== "string"
      : !("id" in message) || (!("result" in message) && !("error" in message)))
  ) {
    throw incomplete("producer_frame_invalid");
  }

  return message as AnyMessage;
}

/**
 * Pull-driven SDK seam. Incoming callbacks are dispatched here so the SDK's
 * eager async receive loop cannot retain arbitrary pending request payloads or
 * print raw messages on validation errors. Only bounded responses reach it.
 */
export function boundedAcpStream(input: {
  source: NodeReadable;
  stdin: NodeWritable;
  client: BoundedAcpClient;
  onFailure: (error: SupervisorError) => void;
}): Stream {
  const iterator = input.source[Symbol.asyncIterator]();
  let pendingPermissions = 0;
  let stopped = false;
  const send = (message: AnyMessage): Promise<void> =>
    writeChunk(
      input.stdin,
      new TextEncoder().encode(`${JSON.stringify(message)}\n`),
    );
  const fail = (
    reason: NonNullable<SupervisorErrorDetails["outputFailure"]>,
  ): void => {
    if (stopped) return;
    stopped = true;
    const error = incomplete(reason);

    input.onFailure(error);
    input.source.destroy(error);
  };

  input.stdin.once("error", () => fail("producer_response_failed"));

  function permission(
    id: string | number | null,
    params: unknown,
  ): Promise<void> {
    if (pendingPermissions >= 32) throw incomplete("producer_permission_limit");
    const parsed = zRequestPermissionRequest.safeParse(params);

    if (!parsed.success) throw incomplete("producer_permission_invalid");
    pendingPermissions += 1;
    // The continuation captures only the small RPC id and the pending count.
    let prepared: () => void = () => {};
    const admission = new Promise<void>((resolve) => {
      prepared = resolve;
    });
    const result = input.client.requestPermission(parsed.data, prepared);

    void result
      .then(
        (outcome) => send({ jsonrpc: "2.0", id, result: outcome }),
        () => {
          fail("producer_permission_failed");
        },
      )
      .catch(() => fail("producer_response_failed"))
      .finally(() => {
        pendingPermissions -= 1;
      });

    return admission;
  }

  function update(params: unknown): Promise<void> {
    const parsed = zSessionNotification.safeParse(params);

    if (!parsed.success) throw incomplete("producer_update_invalid");

    return input.client.sessionUpdate(parsed.data);
  }

  const readable = new ReadableStream<AnyMessage>(
    {
      async pull(controller) {
        try {
          // Allow response continuations to finish before releasing their frame.
          await nextTurn();
          while (!stopped) {
            let next: IteratorResult<unknown> | null = await iterator.next();

            if (next.done) {
              controller.close();

              return;
            }
            let message: AnyMessage | null = parseFrame(
              next.value as Uint8Array,
            );

            next = null;

            if (!("method" in message)) {
              controller.enqueue(message);

              return;
            }
            if (message.method === "session/update" && !("id" in message)) {
              await update(message.params);
            } else if (
              message.method === "session/request_permission" &&
              "id" in message
            ) {
              await permission(message.id, message.params);
            } else {
              throw incomplete("producer_method_unsupported");
            }
            message = null;
          }
        } catch (error) {
          const failure =
            error instanceof SupervisorError
              ? error
              : incomplete("producer_output_incomplete");

          input.onFailure(failure);
          controller.error(failure);
          await iterator.return?.();
        }
      },
      async cancel() {
        stopped = true;
        await iterator.return?.();
      },
    },
    { highWaterMark: 0 },
  );
  const writable = new WritableStream<AnyMessage>({ write: send });

  return { readable, writable } as unknown as Stream;
}
