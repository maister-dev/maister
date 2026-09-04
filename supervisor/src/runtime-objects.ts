import type { HostRuntimeObjectRow, HostState } from "./host-state";
import type { ReserveRuntimeObjectPayload } from "./types";

import { createHash } from "node:crypto";
import { lstat, mkdir, open, realpath, rename, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

import { SupervisorError } from "./types";

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

function publicMetadata(row: HostRuntimeObjectRow): RuntimeObjectPublicMetadata {
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

function objectPath(root: string, objectId: string, generation: number): string {
  const path = resolve(root, `${objectId}.${generation}`);
  const prefix = `${resolve(root)}/`;
  if (!path.startsWith(prefix)) {
    throw new SupervisorError("PRECONDITION", "runtime object identifier is invalid", {
      details: { reason: "runtime_object_missing" },
    });
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
      privatePath: objectPath(this.root, input.payload.objectId, input.payload.generation),
      createdAt,
      sealedAt: null,
      expiresAt: input.payload.expiresAt ?? null,
      deletedAt: null,
      lastError: null,
    });
    return publicMetadata(requireObject(this.state, input.payload.objectId));
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
      throw new SupervisorError("FENCED", "runtime object upload fence is stale", {
        details: { reason: "assignment_fenced" },
      });
    }
    if (object.state === "available") {
      if (object.sizeBytes === input.sizeBytes && object.sha256 === input.sha256) {
        return publicMetadata(object);
      }
      throw new SupervisorError(
        "PRECONDITION",
        "runtime object upload differs from sealed metadata",
        { details: { reason: "command_invariant_conflict" } },
      );
    }
    if (object.state !== "pending") {
      throw new SupervisorError("PRECONDITION", "runtime object cannot accept content", {
        details: { reason: "runtime_object_missing" },
      });
    }
    if (input.sizeBytes > MAX_RUNTIME_OBJECT_BYTES) {
      throw new SupervisorError("PRECONDITION", "runtime object content size is invalid", {
        details: { reason: "runtime_object_integrity_mismatch" },
      });
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

  async read(objectId: string): Promise<{ metadata: RuntimeObjectPublicMetadata; path: string }> {
    const object = requireObject(this.state, objectId);
    if (object.state !== "available") {
      throw new SupervisorError("PRECONDITION", "runtime object content is unavailable", {
        details: { reason: "runtime_object_missing" },
      });
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
      throw new SupervisorError("FENCED", "runtime object deletion fence is stale", {
        details: { reason: "assignment_fenced" },
      });
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
      const failed = this.state.updateRuntimeObject(object.id, {
        state: "corrupt",
        sizeBytes: object.sizeBytes,
        sha256: object.sha256,
        sealedAt: object.sealedAt,
        deletedAt: null,
        lastError: { message: error instanceof Error ? error.message : String(error) },
      });
      return publicMetadata(failed);
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
