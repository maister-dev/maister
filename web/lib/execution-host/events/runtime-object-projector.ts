import "server-only";

import type { Db } from "@/lib/execution-host/db";

import { and, desc, eq } from "drizzle-orm";

import { SessionContentReferenceSchema } from "../runtime-events";

import { CANONICAL_PROJECTION_CONSUMERS } from "./projection-consumers";
import {
  ExecutionEventProjectionError,
  projectExecutionEvents,
  type ExecutionEventProjectorSummary,
  type ExecutionEventProjector,
} from "./projector";

import {
  executionAssignments,
  executionCommands,
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

async function hasCurrentFence(
  tx: Db,
  event: ExecutionEvent,
): Promise<boolean> {
  if (
    event.source !== "host" ||
    !event.executionHostId ||
    !event.executionAssignmentId ||
    event.assignmentEpoch === null
  ) {
    throw permanent(
      "runtime object event is missing its host assignment fence",
    );
  }
  const run = await tx
    .select({ executionDataPlaneMode: runs.executionDataPlaneMode })
    .from(runs)
    .where(eq(runs.id, event.runId))
    .limit(1);

  if (!run[0]) throw permanent("runtime object event references a missing run");
  const assignment = await tx
    .select({ id: executionAssignments.id })
    .from(executionAssignments)
    .where(
      and(
        eq(executionAssignments.id, event.executionAssignmentId),
        eq(executionAssignments.runId, event.runId),
        eq(executionAssignments.executionHostId, event.executionHostId),
        eq(executionAssignments.epoch, event.assignmentEpoch),
        eq(executionAssignments.state, "active"),
      ),
    )
    .limit(1);

  return Boolean(assignment[0]);
}

async function projectAvailable(tx: Db, event: ExecutionEvent): Promise<void> {
  if (
    !event.executionHostId ||
    !event.executionAssignmentId ||
    event.assignmentEpoch === null
  ) {
    throw permanent("runtime object available event is missing its fence");
  }
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
  // Two consumers may hydrate the same content before either catalogues it.
  // The insert serializes absence; a losing writer must validate the committed
  // row below, including all immutable metadata, before accepting the replay.
  const inserted = await tx
    .insert(executionRuntimeObjects)
    .values({
      id: objectId,
      runId: event.runId,
      executionHostId: event.executionHostId,
      executionAssignmentId: event.executionAssignmentId,
      assignmentEpoch: event.assignmentEpoch,
      kind: kind as (typeof RUNTIME_OBJECT_KINDS)[number],
      logicalName,
      mimeType,
      sizeBytes: BigInt(sizeBytes),
      sha256: checksum,
      generation,
      retentionClass:
        retentionClass as (typeof RUNTIME_OBJECT_RETENTION_CLASSES)[number],
      state: "available",
      sourceEventId: event.id,
      createdAt: event.occurredAt,
      sealedAt,
      expiresAt,
    })
    .onConflictDoNothing({ target: executionRuntimeObjects.id })
    .returning({ id: executionRuntimeObjects.id });

  if (inserted.length > 0) return;
  const rows = await tx
    .select()
    .from(executionRuntimeObjects)
    .where(eq(executionRuntimeObjects.id, objectId))
    .for("update")
    .limit(1);
  const existing = rows[0];

  if (existing) {
    const sameBinding =
      existing.runId === event.runId &&
      existing.executionHostId === event.executionHostId &&
      existing.executionAssignmentId === event.executionAssignmentId &&
      existing.assignmentEpoch === event.assignmentEpoch &&
      existing.kind === kind &&
      existing.logicalName === logicalName &&
      existing.mimeType === mimeType &&
      existing.generation === generation &&
      existing.retentionClass === retentionClass &&
      existing.expiresAt?.getTime() === expiresAt?.getTime();
    const exactReplay =
      sameBinding &&
      existing.state === "available" &&
      existing.sizeBytes === BigInt(sizeBytes) &&
      existing.sha256 === checksum &&
      existing.sourceEventId === event.id &&
      existing.sealedAt?.getTime() === sealedAt.getTime() &&
      existing.deletedAt === null &&
      existing.lastError === null;

    if (exactReplay) return;

    const receiptReconciled =
      sameBinding &&
      existing.state === "available" &&
      existing.sizeBytes === BigInt(sizeBytes) &&
      existing.sha256 === checksum &&
      existing.sourceEventId === null &&
      existing.deletedAt === null &&
      existing.lastError === null;

    if (receiptReconciled) {
      await tx
        .update(executionRuntimeObjects)
        .set({ sourceEventId: event.id })
        .where(eq(executionRuntimeObjects.id, objectId));

      return;
    }

    const reserveRows = await tx
      .select({ payload: executionCommands.payload })
      .from(executionCommands)
      .where(
        and(
          eq(executionCommands.runId, event.runId),
          eq(executionCommands.executionHostId, event.executionHostId),
          eq(
            executionCommands.executionAssignmentId,
            event.executionAssignmentId,
          ),
          eq(executionCommands.assignmentEpoch, event.assignmentEpoch),
          eq(executionCommands.kind, "runtime_object.reserve"),
          eq(executionCommands.targetSessionId, objectId),
        ),
      )
      .orderBy(desc(executionCommands.createdAt))
      .limit(1);
    const reservePayload = reserveRows[0]?.payload;
    const reserveDeclarationMatches =
      reservePayload === undefined ||
      (reservePayload.sizeBytes === sizeBytes &&
        reservePayload.sha256 === checksum);
    const matchesPendingIntent =
      sameBinding &&
      existing.state === "pending" &&
      existing.sizeBytes === null &&
      existing.sha256 === null &&
      existing.sealedAt === null &&
      reserveDeclarationMatches;

    if (!matchesPendingIntent) {
      throw permanent(
        "runtime object available event conflicts with immutable metadata",
      );
    }

    await tx
      .update(executionRuntimeObjects)
      .set({
        sizeBytes: BigInt(sizeBytes),
        sha256: checksum,
        state: "available",
        sourceEventId: event.id,
        sealedAt,
        deletedAt: null,
        lastError: null,
      })
      .where(eq(executionRuntimeObjects.id, objectId));

    return;
  }
  throw permanent("runtime object catalogue row disappeared during projection");
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
  const [command] = await tx
    .select({
      kind: executionCommands.kind,
      targetSessionId: executionCommands.targetSessionId,
    })
    .from(executionCommands)
    .innerJoin(
      executionAssignments,
      eq(executionAssignments.id, executionCommands.executionAssignmentId),
    )
    .where(
      and(
        eq(executionCommands.id, commandId),
        eq(executionCommands.runId, event.runId),
        eq(
          executionCommands.executionAssignmentId,
          event.executionAssignmentId,
        ),
        eq(executionCommands.executionHostId, event.executionHostId),
        eq(executionCommands.assignmentEpoch, event.assignmentEpoch),
        eq(executionAssignments.runId, event.runId),
        eq(executionAssignments.executionHostId, event.executionHostId),
        eq(executionAssignments.epoch, event.assignmentEpoch),
      ),
    )
    .limit(1);

  if (
    !command ||
    (command.kind !== "session.create" &&
      command.targetSessionId !== event.hostSessionId)
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
  // A reservation has no manager catalogue row yet. Its content event is the
  // first durable metadata record, so pending is intentionally audit-only.
  if (state === "pending") return;
  const existing = await tx
    .select()
    .from(executionRuntimeObjects)
    .where(eq(executionRuntimeObjects.id, objectId))
    .for("update")
    .limit(1);
  const object = existing[0];

  if (
    !object ||
    object.runId !== event.runId ||
    object.executionHostId !== event.executionHostId ||
    object.executionAssignmentId !== event.executionAssignmentId ||
    object.assignmentEpoch !== event.assignmentEpoch ||
    object.generation !== generation
  ) {
    throw permanent(
      "runtime object state event has no matching catalogue object",
    );
  }
  const deletedAtRaw = event.payload?.deletedAt;
  const deletedAt =
    deletedAtRaw === null || deletedAtRaw === undefined
      ? object.deletedAt
      : timestampField(event.payload, "deletedAt");

  await tx
    .update(executionRuntimeObjects)
    .set({
      state: state as (typeof RUNTIME_OBJECT_STATES)[number],
      sourceEventId: event.id,
      deletedAt: state === "deleted" ? deletedAt : object.deletedAt,
      lastError: null,
    })
    .where(eq(executionRuntimeObjects.id, objectId));
}

export async function projectRuntimeObject(
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
    await projectAvailable(tx, { ...event, payload: reference.data });

    return;
  }
  if (
    event.eventType !== "runtime_object.available" &&
    event.eventType !== "runtime_object.state"
  ) {
    return;
  }
  if (event.eventType === "runtime_object.available") {
    if (!(await hasCurrentFence(tx, event))) return;
    await projectAvailable(tx, event);
  } else {
    await projectState(tx, event);
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
