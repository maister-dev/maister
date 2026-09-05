import "server-only";

import type { Db } from "./db";
import type {
  ExecutionHostTransport,
  RuntimeObjectContent,
  RuntimeObjectContentStream,
  RuntimeObjectMetadata,
} from "./contracts";
import type { BoundClient } from "./client";
import type { RuntimeObjectKind, RuntimeObjectRetentionClass } from "./types";
import type { ExecutionHost, ExecutionRuntimeObject } from "@/lib/db/schema";

import { randomUUID, createHash } from "node:crypto";

import { and, eq } from "drizzle-orm";

import { defaultTransport } from "./default-transport";

import { executionHosts, executionRuntimeObjects, runs } from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";

export const MAX_RUNTIME_OBJECT_BYTES = 26_214_400;

const RUNTIME_OBJECT_UUID_NAMESPACE = Buffer.from(
  "6ba7b8119dad11d180b400c04fd430c8",
  "hex",
);

export type RuntimeObjectWithRun = {
  object: ExecutionRuntimeObject;
  projectId: string | null;
  localPackageId: string | null;
  createdByUserId: string | null;
  executionHost: ExecutionHost;
};

export type RuntimeObjectTransportResolver = (
  host: ExecutionHost,
) => Promise<ExecutionHostTransport>;

function integrityError(runId: string, message: string): MaisterError {
  return new MaisterError("CONFLICT", message, {
    details: { reason: "runtime_object_integrity_mismatch", runId },
  });
}

export function assertRuntimeObjectContentHeaders(input: {
  runId: string;
  sizeBytes: bigint;
  range?: { start: number; end?: number };
  contentLength: number | null;
  contentRange: string | null;
}): void {
  const total = Number(input.sizeBytes);

  if (!Number.isSafeInteger(total) || total < 0) {
    throw integrityError(
      input.runId,
      "runtime object catalogue size is invalid",
    );
  }
  if (!input.range) {
    if (input.contentRange !== null || input.contentLength !== total) {
      throw integrityError(
        input.runId,
        "runtime object response length differs from its manager catalogue",
      );
    }

    return;
  }

  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(input.contentRange ?? "");
  const start = match ? Number(match[1]) : NaN;
  const end = match ? Number(match[2]) : NaN;
  const responseTotal = match ? Number(match[3]) : NaN;
  const expectedEnd = input.range.end ?? total - 1;

  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    !Number.isSafeInteger(responseTotal) ||
    start !== input.range.start ||
    end !== expectedEnd ||
    responseTotal !== total ||
    input.contentLength !== end - start + 1
  ) {
    throw integrityError(
      input.runId,
      "runtime object range metadata differs from its manager catalogue",
    );
  }
}

// A retried manager operation must address the same host object. The ID binds
// that operation to the exact bytes without leaking a manager-selected path.
export function deterministicRuntimeObjectId(input: {
  runId: string;
  sourceKey: string;
  sha256: string;
}): string {
  const name = [
    "urn:maister:runtime-object",
    `run:${encodeURIComponent(input.runId)}`,
    `source:${encodeURIComponent(input.sourceKey)}`,
    `sha256:${input.sha256}`,
  ].join(":");
  const bytes = Buffer.from(
    createHash("sha1")
      .update(RUNTIME_OBJECT_UUID_NAMESPACE.toString("hex"), "hex")
      .update(name, "utf8")
      .digest()
      .subarray(0, 16),
  );

  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function deterministicRuntimeOutputObjectId(input: {
  runId: string;
  sourceKey: string;
}): string {
  return deterministicRuntimeObjectId({
    ...input,
    sha256: createHash("sha256")
      .update(`runtime-output-allocation:${input.sourceKey}`, "utf8")
      .digest("hex"),
  });
}

// The manager never chooses a host path. It reserves an opaque object ID through
// the run-bound command ledger, transfers a bounded byte buffer, and lets the
// host's durable runtime event make the manager catalogue authoritative.
export async function publishRuntimeObject(input: {
  client: BoundClient;
  objectId?: string;
  kind: RuntimeObjectKind;
  logicalName: string;
  mimeType: string;
  generation?: number;
  retentionClass: RuntimeObjectRetentionClass;
  expiresAt?: string | null;
  bytes: Uint8Array;
}): Promise<{ objectId: string; metadata: RuntimeObjectMetadata }> {
  if (input.bytes.byteLength > MAX_RUNTIME_OBJECT_BYTES) {
    throw new MaisterError(
      "PRECONDITION",
      `runtime object exceeds the ${MAX_RUNTIME_OBJECT_BYTES}-byte limit`,
      { details: { reason: "runtime_object_integrity_mismatch" } },
    );
  }
  const objectId = input.objectId ?? randomUUID();
  const generation = input.generation ?? 1;
  const sha256 = createHash("sha256").update(input.bytes).digest("hex");
  const reserved = await input.client.reserveRuntimeObject({
    objectId,
    kind: input.kind,
    logicalName: input.logicalName,
    mimeType: input.mimeType,
    sizeBytes: input.bytes.byteLength,
    sha256,
    generation,
    retentionClass: input.retentionClass,
    expiresAt: input.expiresAt,
  });

  if (reserved.state === "available") {
    if (
      reserved.generation === generation &&
      reserved.sizeBytes === input.bytes.byteLength &&
      reserved.sha256 === sha256
    ) {
      return { objectId, metadata: reserved };
    }
    throw new MaisterError(
      "CONFLICT",
      "runtime object ID is already sealed with different content",
      { details: { reason: "runtime_object_integrity_mismatch" } },
    );
  }

  const metadata = await input.client.uploadRuntimeObject({
    objectId,
    generation,
    bytes: input.bytes,
    sha256,
  });

  return { objectId, metadata };
}

// Object and project identity are loaded together from manager-owned state.
// A URL can select only the opaque IDs; it cannot select a host, assignment,
// or any filesystem location.
export async function getRuntimeObjectForRun(input: {
  db: Db;
  runId: string;
  objectId: string;
}): Promise<RuntimeObjectWithRun | null> {
  const rows = await input.db
    .select({
      object: executionRuntimeObjects,
      projectId: runs.projectId,
      localPackageId: runs.localPackageId,
      createdByUserId: runs.createdByUserId,
      executionHost: executionHosts,
    })
    .from(executionRuntimeObjects)
    .innerJoin(runs, eq(runs.id, executionRuntimeObjects.runId))
    .innerJoin(
      executionHosts,
      eq(executionHosts.id, executionRuntimeObjects.executionHostId),
    )
    .where(
      and(
        eq(executionRuntimeObjects.id, input.objectId),
        eq(executionRuntimeObjects.runId, input.runId),
      ),
    )
    .limit(1);

  return rows[0] ?? null;
}

export async function readRuntimeObjectContent(input: {
  db: Db;
  runId: string;
  objectId: string;
  range?: { start: number; end?: number };
  transportForHost?: RuntimeObjectTransportResolver;
}): Promise<{ object: ExecutionRuntimeObject; content: RuntimeObjectContent }> {
  const opened = await openRuntimeObjectContent(input);

  return {
    object: opened.object,
    content: {
      bytes: new Uint8Array(
        await new Response(opened.content.body).arrayBuffer(),
      ),
      contentRange: opened.content.contentRange,
      contentDigest: opened.content.contentDigest,
    },
  };
}

export async function openRuntimeObjectContent(input: {
  db: Db;
  runId: string;
  objectId: string;
  range?: { start: number; end?: number };
  transportForHost?: RuntimeObjectTransportResolver;
}): Promise<{
  object: ExecutionRuntimeObject;
  content: RuntimeObjectContentStream;
}> {
  const loaded = await getRuntimeObjectForRun(input);

  if (!loaded) {
    throw new MaisterError(
      "PRECONDITION",
      "runtime object was not found for this run",
      {
        details: { reason: "runtime_object_missing", runId: input.runId },
      },
    );
  }
  if (loaded.object.state !== "available" || !loaded.object.sha256) {
    throw new MaisterError(
      "PRECONDITION",
      "runtime object content is not available",
      {
        details: { reason: "runtime_object_missing", runId: input.runId },
      },
    );
  }
  const transport = input.transportForHost
    ? await input.transportForHost(loaded.executionHost)
    : defaultRuntimeObjectTransport(loaded.executionHost);
  const content = await transport.openRuntimeObjectContent(input.objectId, {
    range: input.range,
  });
  const expectedDigest = `sha-256=:${Buffer.from(loaded.object.sha256, "hex").toString("base64")}:`;

  if (content.contentDigest !== expectedDigest) {
    throw integrityError(
      input.runId,
      "runtime object content digest differs from its manager catalogue",
    );
  }
  if (loaded.object.sizeBytes === null) {
    throw integrityError(
      input.runId,
      "available runtime object has no manager catalogue size",
    );
  }
  assertRuntimeObjectContentHeaders({
    runId: input.runId,
    sizeBytes: loaded.object.sizeBytes,
    range: input.range,
    contentLength: content.contentLength,
    contentRange: content.contentRange,
  });

  return { object: loaded.object, content };
}

function defaultRuntimeObjectTransport(
  host: ExecutionHost,
): ExecutionHostTransport {
  if (host.kind !== "local_direct") {
    throw new MaisterError(
      "EXECUTOR_UNAVAILABLE",
      "runtime object host transport is not installed",
      {
        details: {
          reason: "runtime_object_transport_unsupported",
          executionHostId: host.id,
        },
      },
    );
  }

  return defaultTransport();
}
