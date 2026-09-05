import type { HostRuntimeObjectRow, HostState } from "./host-state";
import type {
  ReserveRuntimeObjectPayload,
  RuntimeObjectOutputBinding,
} from "./types";

import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  readSync,
  writeSync,
  unlinkSync,
} from "node:fs";
import {
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { resolve } from "node:path";

import { SupervisorError } from "./types";
import { encodeSessionContent } from "./session-content-json";

export const MAX_RUNTIME_OBJECT_BYTES = 26_214_400;

export type RuntimeObjectPublicMetadata = {
  objectId: string;
  kind: string;
  logicalName: string;
  mimeType: string;
  sizeBytes: number | null;
  sha256: string | null;
  generation: number;
  retentionClass: string;
  state: HostRuntimeObjectRow["state"];
  createdAt: string;
  sealedAt: string | null;
  expiresAt: string | null;
  deletedAt: string | null;
};

function publicMetadata(
  row: HostRuntimeObjectRow,
): RuntimeObjectPublicMetadata {
  return {
    objectId: row.id,
    kind: row.kind,
    logicalName: row.logicalName,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    sha256: row.sha256,
    generation: row.generation,
    retentionClass: row.retentionClass,
    state: row.state,
    createdAt: row.createdAt,
    sealedAt: row.sealedAt,
    expiresAt: row.expiresAt,
    deletedAt: row.deletedAt,
  };
}

function objectPath(
  root: string,
  objectId: string,
  generation: number,
): string {
  const path = resolve(root, `${objectId}.${generation}`);
  const prefix = `${resolve(root)}/`;

  if (!path.startsWith(prefix)) {
    throw new SupervisorError(
      "PRECONDITION",
      "runtime object identifier is invalid",
      {
        details: { reason: "runtime_object_missing" },
      },
    );
  }

  return path;
}

function requireObject(
  state: HostState,
  objectId: string,
): HostRuntimeObjectRow {
  const object = state.getRuntimeObject(objectId);

  if (!object) {
    throw new SupervisorError("PRECONDITION", "runtime object is missing", {
      details: { reason: "runtime_object_missing" },
    });
  }

  return object;
}

export class RuntimeObjectRegistry {
  constructor(
    private readonly state: HostState,
    private readonly root: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Publishes a bounded producer segment before its synchronous SQLite event. */
  captureSessionContent(input: {
    runId: string;
    assignmentId: string;
    assignmentEpoch: number;
    hostSessionId: string;
    payload: Record<string, unknown>;
  }): RuntimeObjectPublicMetadata {
    return this.captureProducerBytes({
      ...input,
      logicalName: "session-content.json",
      mimeType: "application/json",
      chunks: encodeSessionContent(input.payload),
    });
  }

  captureStdoutSegment(input: {
    runId: string;
    assignmentId: string;
    assignmentEpoch: number;
    hostSessionId: string;
    descriptor: number;
    sizeBytes: number;
  }): RuntimeObjectPublicMetadata {
    return this.captureProducerBytes({
      ...input,
      logicalName: "stdout-overflow.ndjson",
      mimeType: "application/x-ndjson",
      chunks: readCapturedBytes(input.descriptor, input.sizeBytes),
    });
  }

  private captureProducerBytes(input: {
    runId: string;
    assignmentId: string;
    assignmentEpoch: number;
    hostSessionId: string;
    logicalName: string;
    mimeType: string;
    chunks: Iterable<Uint8Array>;
  }): RuntimeObjectPublicMetadata {
    const objectId = randomUUID();
    const privatePath = objectPath(this.root, objectId, 1);
    const temporary = `${privatePath}.tmp`;
    const timestamp = this.now().toISOString();
    const hash = createHash("sha256");
    let sizeBytes = 0;

    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const descriptor = openSync(temporary, "wx", 0o600);

    try {
      for (const chunk of input.chunks) {
        if (sizeBytes + chunk.byteLength > 2_097_152) {
          throw new SupervisorError(
            "ACP_PROTOCOL",
            "session output segment exceeds its byte limit",
            {
              details: { reason: "required_output_incomplete" },
            },
          );
        }
        let written = 0;

        while (written < chunk.byteLength) {
          const count = writeSync(
            descriptor,
            chunk,
            written,
            chunk.byteLength - written,
          );

          if (count === 0)
            throw new SupervisorError(
              "EXECUTOR_UNAVAILABLE",
              "session content storage made no progress",
              { details: { reason: "required_output_incomplete" } },
            );
          written += count;
        }
        hash.update(chunk);
        sizeBytes += chunk.byteLength;
      }
      fsyncSync(descriptor);
    } catch (error) {
      this.state.reportRuntimeStorageFailure(error);
      if (this.state.runtimeStorageAvailable()) unlinkSync(temporary);
      throw error;
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporary, privatePath);
    const directory = openSync(this.root, "r");

    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
    this.state.insertRuntimeObject({
      id: objectId,
      runId: input.runId,
      assignmentId: input.assignmentId,
      assignmentEpoch: input.assignmentEpoch,
      hostSessionId: input.hostSessionId,
      kind: "raw_transcript",
      logicalName: input.logicalName,
      mimeType: input.mimeType,
      sizeBytes,
      sha256: hash.digest("hex"),
      generation: 1,
      retentionClass: "run",
      state: "available",
      privatePath,
      createdAt: timestamp,
      sealedAt: timestamp,
      expiresAt: null,
      deletedAt: null,
      lastError: null,
    });

    return publicMetadata(requireObject(this.state, objectId));
  }

  async reserve(input: {
    runId: string;
    assignmentId: string;
    assignmentEpoch: number;
    payload: ReserveRuntimeObjectPayload;
  }): Promise<RuntimeObjectPublicMetadata> {
    const existing = this.state.getRuntimeObject(input.payload.objectId);

    if (existing) {
      if (
        existing.runId !== input.runId ||
        existing.assignmentId !== input.assignmentId ||
        existing.assignmentEpoch !== input.assignmentEpoch ||
        existing.kind !== input.payload.kind ||
        existing.logicalName !== input.payload.logicalName ||
        existing.mimeType !== input.payload.mimeType ||
        existing.sizeBytes !== input.payload.sizeBytes ||
        existing.sha256 !== input.payload.sha256 ||
        existing.generation !== input.payload.generation ||
        existing.retentionClass !== input.payload.retentionClass ||
        existing.expiresAt !== (input.payload.expiresAt ?? null)
      ) {
        throw new SupervisorError(
          "PRECONDITION",
          "runtime object id is already bound to different metadata",
          { details: { reason: "command_invariant_conflict" } },
        );
      }

      return publicMetadata(existing);
    }
    await mkdir(this.root, { recursive: true });
    const createdAt = this.now().toISOString();

    this.state.insertRuntimeObject({
      id: input.payload.objectId,
      runId: input.runId,
      assignmentId: input.assignmentId,
      assignmentEpoch: input.assignmentEpoch,
      hostSessionId: null,
      kind: input.payload.kind,
      logicalName: input.payload.logicalName,
      mimeType: input.payload.mimeType,
      sizeBytes: input.payload.sizeBytes,
      sha256: input.payload.sha256,
      generation: input.payload.generation,
      retentionClass: input.payload.retentionClass,
      state: "pending",
      privatePath: objectPath(
        this.root,
        input.payload.objectId,
        input.payload.generation,
      ),
      createdAt,
      sealedAt: null,
      expiresAt: input.payload.expiresAt ?? null,
      deletedAt: null,
      lastError: null,
    });

    return publicMetadata(requireObject(this.state, input.payload.objectId));
  }

  async allocateOutput(input: {
    runId: string;
    assignmentId: string;
    assignmentEpoch: number;
    hostSessionId: string;
    binding: RuntimeObjectOutputBinding;
  }): Promise<{ metadata: RuntimeObjectPublicMetadata; path: string }> {
    const existing = this.state.getRuntimeObject(input.binding.objectId);

    if (existing) {
      if (
        existing.runId !== input.runId ||
        existing.assignmentId !== input.assignmentId ||
        existing.assignmentEpoch !== input.assignmentEpoch ||
        existing.hostSessionId !== input.hostSessionId ||
        existing.kind !== input.binding.kind ||
        existing.logicalName !== input.binding.logicalName ||
        existing.mimeType !== input.binding.mimeType ||
        existing.generation !== input.binding.generation ||
        existing.retentionClass !== input.binding.retentionClass ||
        existing.expiresAt !== (input.binding.expiresAt ?? null)
      ) {
        throw new SupervisorError(
          "PRECONDITION",
          "runtime output object id is already bound to different metadata",
          { details: { reason: "command_invariant_conflict" } },
        );
      }

      return { metadata: publicMetadata(existing), path: existing.privatePath };
    }

    await mkdir(this.root, { recursive: true });
    const createdAt = this.now().toISOString();
    const privatePath = objectPath(
      this.root,
      input.binding.objectId,
      input.binding.generation,
    );

    this.state.insertRuntimeObject({
      id: input.binding.objectId,
      runId: input.runId,
      assignmentId: input.assignmentId,
      assignmentEpoch: input.assignmentEpoch,
      hostSessionId: input.hostSessionId,
      kind: input.binding.kind,
      logicalName: input.binding.logicalName,
      mimeType: input.binding.mimeType,
      sizeBytes: null,
      sha256: null,
      generation: input.binding.generation,
      retentionClass: input.binding.retentionClass,
      state: "pending",
      privatePath,
      createdAt,
      sealedAt: null,
      expiresAt: input.binding.expiresAt ?? null,
      deletedAt: null,
      lastError: null,
    });

    return {
      metadata: publicMetadata(
        requireObject(this.state, input.binding.objectId),
      ),
      path: privatePath,
    };
  }

  async sealOutput(input: {
    objectId: string;
    hostSessionId: string;
  }): Promise<RuntimeObjectPublicMetadata> {
    const object = requireObject(this.state, input.objectId);

    if (object.hostSessionId !== input.hostSessionId) {
      throw new SupervisorError(
        "FENCED",
        "runtime output object belongs to a different host session",
        { details: { reason: "assignment_fenced" } },
      );
    }
    if (object.state === "available") return publicMetadata(object);
    if (object.state !== "pending") {
      throw new SupervisorError(
        "PRECONDITION",
        `runtime output object cannot be sealed from state ${object.state}`,
        { details: { reason: "runtime_object_missing" } },
      );
    }

    let metadata: Awaited<ReturnType<typeof lstat>>;

    try {
      metadata = await lstat(object.privatePath);
    } catch (error) {
      throw new SupervisorError(
        "PRECONDITION",
        `required runtime output ${object.logicalName} was not produced`,
        { cause: error, details: { reason: "runtime_object_missing" } },
      );
    }
    if (!metadata.isFile() || metadata.size > MAX_RUNTIME_OBJECT_BYTES) {
      throw new SupervisorError(
        "PRECONDITION",
        `runtime output ${object.logicalName} is not a bounded regular file`,
        {
          details: {
            reason:
              metadata.size > MAX_RUNTIME_OBJECT_BYTES
                ? "runtime_object_too_large"
                : "runtime_object_missing",
          },
        },
      );
    }

    const digest = createHash("sha256");
    const handle = await open(object.privatePath, "r");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let sizeBytes = 0;

    try {
      for (;;) {
        const result = await handle.read(buffer, 0, buffer.byteLength, null);

        if (result.bytesRead === 0) break;
        sizeBytes += result.bytesRead;
        if (sizeBytes > MAX_RUNTIME_OBJECT_BYTES) {
          throw new SupervisorError(
            "PRECONDITION",
            `runtime output ${object.logicalName} exceeds the byte limit`,
            { details: { reason: "runtime_object_too_large" } },
          );
        }
        digest.update(buffer.subarray(0, result.bytesRead));
      }
    } finally {
      await handle.close();
    }

    const sealed = this.state.updateRuntimeObject(object.id, {
      state: "available",
      sizeBytes,
      sha256: digest.digest("hex"),
      sealedAt: this.now().toISOString(),
      deletedAt: null,
      lastError: null,
    });

    return publicMetadata(sealed);
  }

  async discardPendingOutputs(input: {
    objectIds: readonly string[];
    hostSessionId: string;
  }): Promise<void> {
    for (const objectId of input.objectIds) {
      const object = this.state.getRuntimeObject(objectId);

      if (
        !object ||
        object.hostSessionId !== input.hostSessionId ||
        object.state !== "pending"
      ) {
        continue;
      }
      await rm(object.privatePath, { force: true });
      this.state.deleteRuntimeObject(objectId);
    }
  }

  metadata(objectId: string): RuntimeObjectPublicMetadata {
    return publicMetadata(requireObject(this.state, objectId));
  }

  async upload(input: {
    objectId: string;
    assignmentId: string;
    assignmentEpoch: number;
    generation: number;
    sizeBytes: number;
    sha256: string;
    chunks: AsyncIterable<Uint8Array>;
  }): Promise<RuntimeObjectPublicMetadata> {
    const object = requireObject(this.state, input.objectId);

    if (
      object.assignmentId !== input.assignmentId ||
      object.assignmentEpoch !== input.assignmentEpoch ||
      object.generation !== input.generation ||
      object.sizeBytes !== input.sizeBytes ||
      object.sha256 !== input.sha256
    ) {
      throw new SupervisorError(
        "FENCED",
        "runtime object upload fence is stale",
        {
          details: { reason: "assignment_fenced" },
        },
      );
    }
    if (object.state === "available") {
      if (
        object.sizeBytes === input.sizeBytes &&
        object.sha256 === input.sha256
      ) {
        return publicMetadata(object);
      }
      throw new SupervisorError(
        "PRECONDITION",
        "runtime object upload differs from sealed metadata",
        { details: { reason: "command_invariant_conflict" } },
      );
    }
    if (object.state !== "pending") {
      throw new SupervisorError(
        "PRECONDITION",
        "runtime object cannot accept content",
        {
          details: { reason: "runtime_object_missing" },
        },
      );
    }
    if (input.sizeBytes > MAX_RUNTIME_OBJECT_BYTES) {
      throw new SupervisorError(
        "PRECONDITION",
        "runtime object content size is invalid",
        {
          details: { reason: "runtime_object_integrity_mismatch" },
        },
      );
    }
    await mkdir(this.root, { recursive: true });
    const temporary = `${object.privatePath}.${input.generation}.partial`;
    const digest = createHash("sha256");
    let receivedBytes = 0;

    try {
      const handle = await open(temporary, "w", 0o600);

      try {
        for await (const chunk of input.chunks) {
          const bytes = Buffer.from(chunk);

          receivedBytes += bytes.byteLength;
          if (
            receivedBytes > input.sizeBytes ||
            receivedBytes > MAX_RUNTIME_OBJECT_BYTES
          ) {
            throw new SupervisorError(
              "PRECONDITION",
              "runtime object content exceeds its declared size",
              { details: { reason: "runtime_object_integrity_mismatch" } },
            );
          }
          digest.update(bytes);
          let offset = 0;

          while (offset < bytes.byteLength) {
            const written = await handle.write(
              bytes,
              offset,
              bytes.byteLength - offset,
            );

            offset += written.bytesWritten;
          }
        }
      } finally {
        await handle.close();
      }
      const actualDigest = digest.digest("hex");

      if (receivedBytes !== input.sizeBytes || actualDigest !== input.sha256) {
        throw new SupervisorError(
          "PRECONDITION",
          "runtime object content does not match its declared size and checksum",
          { details: { reason: "runtime_object_integrity_mismatch" } },
        );
      }
      await rename(temporary, object.privatePath);
      const written = await stat(object.privatePath);

      if (written.size !== input.sizeBytes) {
        throw new Error("runtime object size changed during sealing");
      }
    } catch (error) {
      this.state.reportRuntimeStorageFailure(error);
      if (this.state.runtimeStorageAvailable())
        await rm(temporary, { force: true });
      throw error;
    }
    const sealed = this.state.updateRuntimeObject(object.id, {
      state: "available",
      sizeBytes: input.sizeBytes,
      sha256: input.sha256,
      sealedAt: this.now().toISOString(),
      deletedAt: null,
      lastError: null,
    });

    return publicMetadata(sealed);
  }

  async read(
    objectId: string,
  ): Promise<{ metadata: RuntimeObjectPublicMetadata; path: string }> {
    const object = requireObject(this.state, objectId);

    if (object.state !== "available") {
      throw new SupervisorError(
        "PRECONDITION",
        "runtime object content is unavailable",
        {
          details: { reason: "runtime_object_missing" },
        },
      );
    }

    return { metadata: publicMetadata(object), path: object.privatePath };
  }

  // Prompt references never disclose this path to a caller. The execution host
  // resolves the opaque object only after proving that it belongs to the live
  // run and the exact assignment epoch that owns the session.
  async resolvePromptReference(input: {
    objectId: string;
    runId: string;
    assignmentId: string;
    assignmentEpoch: number;
    expectedKind: ReserveRuntimeObjectPayload["kind"];
  }): Promise<{ metadata: RuntimeObjectPublicMetadata; path: string }> {
    const object = requireObject(this.state, input.objectId);

    if (
      object.runId !== input.runId ||
      object.assignmentId !== input.assignmentId ||
      object.assignmentEpoch !== input.assignmentEpoch
    ) {
      throw new SupervisorError(
        "FENCED",
        "runtime object does not belong to the prompt assignment",
        { details: { reason: "assignment_fenced" } },
      );
    }
    if (object.kind !== input.expectedKind) {
      throw new SupervisorError(
        "PRECONDITION",
        "runtime object kind does not match the requested session input",
        { details: { reason: "command_invariant_conflict" } },
      );
    }
    if (object.state !== "available") {
      throw new SupervisorError(
        "PRECONDITION",
        "runtime object content is unavailable for the prompt",
        { details: { reason: "runtime_object_missing" } },
      );
    }
    const [resolvedRoot, resolvedObject, metadata] = await Promise.all([
      realpath(this.root),
      realpath(object.privatePath),
      Promise.resolve(publicMetadata(object)),
    ]);

    if (!resolvedObject.startsWith(`${resolvedRoot}/`)) {
      throw new SupervisorError(
        "PRECONDITION",
        "runtime object path escapes the host object root",
        { details: { reason: "runtime_object_missing" } },
      );
    }
    if (!(await lstat(resolvedObject)).isFile()) {
      throw new SupervisorError(
        "PRECONDITION",
        "runtime object content is not a regular file",
        { details: { reason: "runtime_object_missing" } },
      );
    }

    return { metadata, path: resolvedObject };
  }

  async remove(input: {
    objectId: string;
    assignmentId: string;
    assignmentEpoch: number;
    generation: number;
  }): Promise<RuntimeObjectPublicMetadata> {
    const object = requireObject(this.state, input.objectId);

    if (
      object.assignmentId !== input.assignmentId ||
      object.assignmentEpoch !== input.assignmentEpoch ||
      object.generation !== input.generation
    ) {
      throw new SupervisorError(
        "FENCED",
        "runtime object deletion fence is stale",
        {
          details: { reason: "assignment_fenced" },
        },
      );
    }
    if (object.state === "deleted") return publicMetadata(object);
    this.state.updateRuntimeObject(object.id, {
      state: "deleting",
      sizeBytes: object.sizeBytes,
      sha256: object.sha256,
      sealedAt: object.sealedAt,
      deletedAt: null,
      lastError: null,
    });
    try {
      await rm(object.privatePath, { force: true });
    } catch (error) {
      this.state.updateRuntimeObject(object.id, {
        state: "deleting",
        sizeBytes: object.sizeBytes,
        sha256: object.sha256,
        sealedAt: object.sealedAt,
        deletedAt: null,
        lastError: {
          message: error instanceof Error ? error.message : String(error),
        },
      });
      throw new SupervisorError(
        "EXECUTOR_UNAVAILABLE",
        `runtime object ${object.id} could not be deleted`,
        {
          cause: error,
          details: { reason: "runtime_object_delete_failed" },
        },
      );
    }
    const deleted = this.state.updateRuntimeObject(object.id, {
      state: "deleted",
      sizeBytes: object.sizeBytes,
      sha256: object.sha256,
      sealedAt: object.sealedAt,
      deletedAt: this.now().toISOString(),
      lastError: null,
    });

    return publicMetadata(deleted);
  }
}

function* readCapturedBytes(
  descriptor: number,
  sizeBytes: number,
): Generator<Uint8Array> {
  if (
    !Number.isSafeInteger(sizeBytes) ||
    sizeBytes < 1 ||
    sizeBytes > 2_097_152
  ) {
    throw new SupervisorError(
      "ACP_PROTOCOL",
      "captured stdout segment size is invalid",
      {
        details: { reason: "required_output_incomplete" },
      },
    );
  }
  const buffer = Buffer.allocUnsafe(65_536);
  let offset = 0;

  while (offset < sizeBytes) {
    const count = readSync(
      descriptor,
      buffer,
      0,
      Math.min(buffer.byteLength, sizeBytes - offset),
      offset,
    );

    if (count === 0)
      throw new SupervisorError(
        "ACP_PROTOCOL",
        "captured stdout segment is incomplete",
        {
          details: { reason: "required_output_incomplete" },
        },
      );
    yield buffer.subarray(0, count);
    offset += count;
  }
}
