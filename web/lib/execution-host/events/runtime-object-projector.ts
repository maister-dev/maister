import "server-only";

import type { Db } from "@/lib/execution-host/db";

import {
  SessionContentReferenceSchema,
  StdoutSegmentMetadataSchema,
} from "../runtime-events";
import {
  reduceRuntimeObjectEvidence,
  RuntimeObjectEvidenceError,
  type RuntimeObjectSeal,
  type RuntimeObjectBinding,
} from "../runtime-object-evidence";
import { hasNativeOutputCommand } from "../runtime-object-intent";

import { CANONICAL_PROJECTION_CONSUMERS } from "./projection-consumers";
import {
  ExecutionEventProjectionError,
  projectExecutionEvents,
  type ExecutionEventProjectorSummary,
  type ExecutionEventProjector,
} from "./projector";

import {
  executionRuntimeObjects,
  runs,
  type ExecutionEvent,
} from "@/lib/db/schema";
import {
  RUNTIME_OBJECT_KINDS,
  RUNTIME_OBJECT_RETENTION_CLASSES,
  RUNTIME_OBJECT_STATES,
} from "@/lib/execution-host/types";

export const canonicalRuntimeObjectProjector: ExecutionEventProjector = {
  consumerName: CANONICAL_PROJECTION_CONSUMERS.runtimeObject,
  project: projectRuntimeObject,
};
const kinds = new Set<string>(RUNTIME_OBJECT_KINDS);
const retentionClasses = new Set<string>(RUNTIME_OBJECT_RETENTION_CLASSES);
const states = new Set<string>(RUNTIME_OBJECT_STATES);
const sha256 = /^[a-f0-9]{64}$/;

function permanent(message: string): ExecutionEventProjectionError {
  return new ExecutionEventProjectionError(message, true);
}

function stringField(
  payload: Record<string, unknown> | null,
  name: string,
): string {
  const value = payload?.[name];

  if (typeof value !== "string" || value.length === 0) {
    throw permanent(`runtime object event is missing ${name}`);
  }

  return value;
}

function numberField(
  payload: Record<string, unknown> | null,
  name: string,
): number {
  const value = payload?.[name];

  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw permanent(`runtime object event has invalid ${name}`);
  }

  return value;
}

function timestampField(
  payload: Record<string, unknown> | null,
  name: string,
): Date {
  const value = stringField(payload, name);
  const parsed = new Date(value);

  if (Number.isNaN(parsed.getTime())) {
    throw permanent(`runtime object event has invalid ${name}`);
  }

  return parsed;
}

function bindingForEvent(
  event: ExecutionEvent,
  objectId: string,
  generation: number,
): RuntimeObjectBinding {
  if (
    event.source !== "host" ||
    event.ingestDisposition !== "accepted" ||
    !event.executionHostId ||
    !event.executionAssignmentId ||
    event.assignmentEpoch === null
  ) {
    throw permanent(
      "runtime object evidence requires its accepted host assignment fence",
    );
  }

  return {
    objectId,
    generation,
    runId: event.runId,
    executionHostId: event.executionHostId,
    executionAssignmentId: event.executionAssignmentId,
    assignmentEpoch: event.assignmentEpoch,
  };
}

function sealForEvent(event: ExecutionEvent): RuntimeObjectSeal {
  const objectId = stringField(event.payload, "objectId");
  const kind = stringField(event.payload, "kind");
  const logicalName = stringField(event.payload, "logicalName");
  const mimeType = stringField(event.payload, "mimeType");
  const checksum = stringField(event.payload, "sha256");
  const retentionClass = stringField(event.payload, "retentionClass");
  const state = stringField(event.payload, "state");
  const generation = numberField(event.payload, "generation");
  const sizeBytes = numberField(event.payload, "sizeBytes");
  const sealedAt =
    typeof event.payload?.sealedAt === "string"
      ? timestampField(event.payload, "sealedAt")
      : event.occurredAt;

  if (
    !kinds.has(kind) ||
    !retentionClasses.has(retentionClass) ||
    state !== "available" ||
    !sha256.test(checksum) ||
    generation < 1 ||
    sizeBytes < 0 ||
    /[\\/]/.test(logicalName)
  ) {
    throw permanent("runtime object available event has invalid metadata");
  }
  const expiresRaw = event.payload?.expiresAt;
  const expiresAt =
    expiresRaw === null || expiresRaw === undefined
      ? null
      : new Date(String(expiresRaw));

  if (expiresAt && Number.isNaN(expiresAt.getTime())) {
    throw permanent("runtime object available event has invalid expiresAt");
  }
  if ((retentionClass === "ephemeral") !== Boolean(expiresAt)) {
    throw permanent("runtime object retention and expiry disagree");
  }

  return {
    objectId,
    kind: kind as RuntimeObjectSeal["kind"],
    logicalName,
    mimeType,
    sizeBytes,
    sha256: checksum,
    generation,
    retentionClass: retentionClass as RuntimeObjectSeal["retentionClass"],
    state: "available",
    sealedAt: sealedAt.toISOString(),
    expiresAt: expiresAt?.toISOString() ?? null,
  };
}

async function projectAvailable(tx: Db, event: ExecutionEvent): Promise<void> {
  const metadata = sealForEvent(event);

  await reduceRuntimeObjectEvidence(
    tx,
    bindingForEvent(event, metadata.objectId, metadata.generation),
    {
      kind: "seal",
      source: "event",
      eventId: event.id,
      metadata,
    },
  );
}

// Bounded session output is allocated by the exact source command, rather
// than a separate reserve call. Its accepted reference carries the allocation.
async function catalogueContentIntent(
  tx: Db,
  event: ExecutionEvent,
): Promise<void> {
  const metadata = sealForEvent(event);
  const binding = bindingForEvent(
    event,
    metadata.objectId,
    metadata.generation,
  );

  await tx
    .insert(executionRuntimeObjects)
    .values({
      id: binding.objectId,
      runId: binding.runId,
      executionHostId: binding.executionHostId,
      executionAssignmentId: binding.executionAssignmentId,
      assignmentEpoch: binding.assignmentEpoch,
      kind: metadata.kind as (typeof RUNTIME_OBJECT_KINDS)[number],
      logicalName: metadata.logicalName,
      mimeType: metadata.mimeType,
      generation: metadata.generation,
      retentionClass:
        metadata.retentionClass as (typeof RUNTIME_OBJECT_RETENTION_CLASSES)[number],
      state: "pending",
      createdAt: event.occurredAt,
      expiresAt: metadata.expiresAt ? new Date(metadata.expiresAt) : null,
    })
    .onConflictDoNothing({ target: executionRuntimeObjects.id });
}

async function assertContentCommandFence(
  tx: Db,
  event: ExecutionEvent,
  commandId: string,
): Promise<void> {
  if (
    event.source !== "host" ||
    event.ingestDisposition !== "accepted" ||
    !event.executionHostId ||
    !event.executionAssignmentId ||
    event.assignmentEpoch === null
  ) {
    throw permanent("session content requires accepted host evidence");
  }
  if (
    !event.hostSessionId ||
    !(await hasNativeOutputCommand(tx, {
      runId: event.runId,
      executionHostId: event.executionHostId,
      executionAssignmentId: event.executionAssignmentId,
      assignmentEpoch: event.assignmentEpoch,
      commandId,
      hostSessionId: event.hostSessionId,
    }))
  ) {
    throw permanent(
      "session content has no matching source command and assignment",
    );
  }
}

async function projectState(tx: Db, event: ExecutionEvent): Promise<void> {
  if (
    !event.executionHostId ||
    !event.executionAssignmentId ||
    event.assignmentEpoch === null
  ) {
    throw permanent("runtime object state event is missing its fence");
  }
  const objectId = stringField(event.payload, "objectId");
  const generation = numberField(event.payload, "generation");
  const state = stringField(event.payload, "state");

  if (!states.has(state) || generation < 1) {
    throw permanent("runtime object state event is invalid");
  }
  const deletedAt =
    event.payload?.deletedAt === null || event.payload?.deletedAt === undefined
      ? null
      : timestampField(event.payload, "deletedAt");

  await reduceRuntimeObjectEvidence(
    tx,
    bindingForEvent(event, objectId, generation),
    {
      kind: "state",
      source: "event",
      eventId: event.id,
      state: state as (typeof RUNTIME_OBJECT_STATES)[number],
      deletedAt,
    },
  );
}

async function applyRuntimeObjectEvent(
  tx: Db,
  event: ExecutionEvent,
): Promise<void> {
  if (event.payload?.contentRef !== undefined) {
    const reference = SessionContentReferenceSchema.safeParse(
      event.payload.contentRef,
    );

    if (
      !reference.success ||
      reference.data.hostSessionId !== event.hostSessionId
    ) {
      throw permanent(
        "session content reference has invalid object or session identity",
      );
    }
    // Historical catalogue evidence does not acquire current domain authority.
    // Accepted output remains reconstructible after its assignment is released.
    await assertContentCommandFence(tx, event, reference.data.commandId);
    const contentEvent = { ...event, payload: reference.data };

    await catalogueContentIntent(tx, contentEvent);
    await projectAvailable(tx, contentEvent);

    return;
  }
  if (
    event.eventType !== "runtime_object.available" &&
    event.eventType !== "runtime_object.state"
  ) {
    return;
  }
  if (event.eventType === "runtime_object.available") {
    if (event.payload?.stdoutSegment !== undefined) {
      const segment = StdoutSegmentMetadataSchema.safeParse(
        event.payload.stdoutSegment,
      );

      if (
        !segment.success ||
        !event.hostSessionId ||
        event.payload.kind !== "raw_transcript" ||
        event.payload.logicalName !== "stdout-overflow.ndjson" ||
        event.payload.mimeType !== "application/x-ndjson" ||
        segment.data.capturedBytes !== event.payload.sizeBytes
      )
        throw permanent("stdout segment allocation is invalid");
      await assertContentCommandFence(tx, event, segment.data.commandId);
      await catalogueContentIntent(tx, event);
    }
    await projectAvailable(tx, event);
  } else {
    await projectState(tx, event);
  }
}

export async function projectRuntimeObject(
  tx: Db,
  event: ExecutionEvent,
): Promise<void> {
  try {
    await applyRuntimeObjectEvent(tx, event);
  } catch (error) {
    if (error instanceof RuntimeObjectEvidenceError)
      throw permanent(
        error.reason === "identity_conflict" ||
          error.reason === "declaration_conflict" ||
          error.reason === "seal_conflict"
          ? "runtime object available event conflicts with immutable metadata"
          : `runtime object evidence refused: ${error.reason}`,
      );
    throw error;
  }
}

export async function projectCanonicalRuntimeObjects(input: {
  db: Db;
  runId: string;
  now?: Date;
  batchSize?: number;
}): Promise<ExecutionEventProjectorSummary> {
  return projectExecutionEvents({
    db: input.db,
    runId: input.runId,
    now: input.now,
    batchSize: input.batchSize,
    projector: canonicalRuntimeObjectProjector,
  });
}

export async function projectPendingCanonicalRuntimeObjects(input: {
  db: Db;
  batchSize?: number;
}): Promise<number> {
  const canonicalRuns = await input.db.select({ id: runs.id }).from(runs);
  let projected = 0;

  for (const run of canonicalRuns) {
    const summary = await projectCanonicalRuntimeObjects({
      db: input.db,
      runId: run.id,
      batchSize: input.batchSize,
    });

    projected += summary.projected;
  }

  return projected;
}
