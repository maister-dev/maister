import "server-only";

import type { FileHandle } from "node:fs/promises";
import type { RuntimeObjectContentStream } from "./contracts";

import { createHash } from "node:crypto";
import { mkdtemp, open, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import pino from "pino";

import {
  MAX_OBJECT_RESPONSE_BYTES,
  parseObjectContentRange,
  parseObjectDigest,
  parseObjectEtag,
} from "../../../runtime/object-integrity";

import { MaisterError } from "@/lib/errors";

const log = pino({
  name: "runtime-object-response",
  level: process.env.LOG_LEVEL ?? "info",
});
const BUFFER_BYTES = 64 * 1024;
let activeResponses = 0;

export function runtimeObjectResponseIntegrityError(): MaisterError {
  return new MaisterError(
    "ACP_PROTOCOL",
    "runtime object response failed integrity verification",
    {
      details: { reason: "runtime_object_integrity_mismatch" },
    },
  );
}

function responseStorageError(): MaisterError {
  return new MaisterError(
    "EXECUTOR_UNAVAILABLE",
    "runtime object response storage is unavailable",
    {
      details: { reason: "runtime_storage_unavailable" },
    },
  );
}

function responseAbortError(): MaisterError {
  return new MaisterError(
    "EXECUTOR_UNAVAILABLE",
    "runtime object response was cancelled",
    {
      details: { reason: "aborted" },
    },
  );
}

/** Validate peer identity without accepting headers as proof of the body. */
export function assertRuntimeObjectResponseIdentity(
  content: Omit<RuntimeObjectContentStream, "body">,
  range?: { start: number; end?: number },
): void {
  const digest = parseObjectDigest(content.contentDigest);
  const representation = parseObjectDigest(content.reprDigest);
  const identity = parseObjectEtag(content.etag);
  const partial = parseObjectContentRange(content.contentRange);
  const length = content.contentLength;

  if (
    !digest ||
    !representation ||
    !identity ||
    identity.sha256 !== representation ||
    (length !== null &&
      (!Number.isSafeInteger(length) ||
        length < 0 ||
        length > MAX_OBJECT_RESPONSE_BYTES)) ||
    (!range && (content.contentRange !== null || digest !== representation)) ||
    (range &&
      (!partial ||
        partial.start !== range.start ||
        partial.end !== (range.end ?? partial.total - 1) ||
        (length !== null && length !== partial.length)))
  ) {
    throw runtimeObjectResponseIntegrityError();
  }
}

/** Hash the actual bounded response before handing its exact anonymous descriptor to a caller. */
export async function verifyRuntimeObjectResponse(
  content: RuntimeObjectContentStream,
  opts: { range?: { start: number; end?: number }; signal?: AbortSignal } = {},
): Promise<RuntimeObjectContentStream> {
  try {
    assertRuntimeObjectResponseIdentity(content, opts.range);
    if (activeResponses >= 2) {
      throw new MaisterError(
        "EXECUTOR_UNAVAILABLE",
        "runtime object response verification is busy; retry the read",
        {
          details: { reason: "command_in_progress" },
        },
      );
    }
    if (opts.signal?.aborted) throw responseAbortError();
  } catch (error) {
    try {
      await content.body.cancel();
    } catch {
      log.warn({ reason: "network" }, "peer cancellation failed");
    }
    throw error;
  }
  activeResponses += 1;
  const reader = content.body.getReader();
  let directory: string | undefined;
  let file: FileHandle | undefined;
  let releasePromise: Promise<void> | undefined;
  let cancelPromise: Promise<void> | undefined;
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let handedOff = false;
  let sourceFinished = false;
  let receivedBytes = 0;
  let digestMatched: boolean | null = null;
  const cancelSource = (): Promise<void> =>
    (cancelPromise ??= sourceFinished ? Promise.resolve() : reader.cancel());
  const abort = (): void => {
    if (handedOff) {
      controller?.error(responseAbortError());
      void release().catch(() =>
        log.error(
          { reason: "runtime_storage_unavailable" },
          "response cleanup failed",
        ),
      );
    } else {
      // Cancellation resolves a blocked network read; the scan awaits this promise.
      void cancelSource().catch(() =>
        log.warn({ reason: "aborted" }, "peer cancellation failed"),
      );
    }
  };
  const release = (): Promise<void> =>
    (releasePromise ??= (async () => {
      opts.signal?.removeEventListener("abort", abort);
      try {
        try {
          await file?.close();
        } finally {
          if (directory) await rm(directory, { recursive: true, force: true });
        }
      } catch {
        throw responseStorageError();
      } finally {
        activeResponses -= 1;
      }
    })());

  opts.signal?.addEventListener("abort", abort, { once: true });
  try {
    directory = await mkdtemp(join(tmpdir(), "maister-object-response-"));
    const path = join(directory, "response");

    file = await open(path, "wx+", 0o600);
    await unlink(path);
    await rm(directory, { recursive: true });
    directory = undefined;
    const hash = createHash("sha256");
    const rangeLength = parseObjectContentRange(content.contentRange)?.length;
    const expectedLength = content.contentLength ?? rangeLength;

    while (true) {
      if (opts.signal?.aborted) throw responseAbortError();
      const next = await reader.read();

      if (opts.signal?.aborted) throw responseAbortError();
      if (next.done) break;
      if (!(next.value instanceof Uint8Array))
        throw runtimeObjectResponseIntegrityError();
      receivedBytes += next.value.byteLength;
      if (
        receivedBytes > MAX_OBJECT_RESPONSE_BYTES ||
        (expectedLength !== undefined && receivedBytes > expectedLength)
      ) {
        throw runtimeObjectResponseIntegrityError();
      }
      hash.update(next.value);
      await file.writeFile(next.value);
    }
    digestMatched =
      hash.digest("hex") === parseObjectDigest(content.contentDigest);

    if (
      !digestMatched ||
      (expectedLength !== undefined && receivedBytes !== expectedLength)
    ) {
      throw runtimeObjectResponseIntegrityError();
    }
    sourceFinished = true;
    reader.releaseLock();
    const verifiedFile = file;
    let offset = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        start(stream) {
          controller = stream;
        },
        async pull(stream) {
          try {
            if (opts.signal?.aborted) throw responseAbortError();
            const bytes = new Uint8Array(
              Math.min(BUFFER_BYTES, receivedBytes - offset),
            );
            const { bytesRead } = await verifiedFile.read(
              bytes,
              0,
              bytes.length,
              offset,
            );

            if (bytesRead !== bytes.length) throw responseStorageError();
            offset += bytesRead;
            if (bytesRead > 0) stream.enqueue(bytes);
            if (offset === receivedBytes) {
              await release();
              stream.close();
            }
          } catch (error) {
            try {
              await release();
            } finally {
              stream.error(
                error instanceof MaisterError ? error : responseStorageError(),
              );
            }
          }
        },
        async cancel() {
          await release();
        },
      },
      { highWaterMark: 0 },
    );

    handedOff = true;
    log.debug(
      {
        receivedBytes,
        range: content.contentRange,
        generation: parseObjectEtag(content.etag)?.generation,
        digestMatched,
      },
      "runtime object response verified",
    );

    return { ...content, body, contentLength: receivedBytes };
  } catch (error) {
    try {
      await cancelSource();
    } catch {
      log.warn({ reason: "network" }, "peer cancellation failed");
    } finally {
      if (!sourceFinished) reader.releaseLock();
      await release();
    }
    const failure =
      error instanceof MaisterError ? error : responseStorageError();

    log.warn(
      {
        receivedBytes,
        expectedBytes: content.contentLength,
        range: content.contentRange,
        generation: parseObjectEtag(content.etag)?.generation,
        digestMatched,
        reason: failure.details?.reason,
      },
      "runtime object response refused",
    );
    throw failure;
  }
}
