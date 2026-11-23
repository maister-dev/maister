import "server-only";

import type { Db } from "@/lib/execution-host/db";

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { and, asc, eq, exists, inArray, ne, or, sql } from "drizzle-orm";
import pino from "pino";

import {
  ADMISSIBLE_PROMPT_INCARNATION_STATES,
  lockCurrentSessionAssignment,
  lockLogicalRunSession,
} from "../session-binding";
import { applyCreateAck } from "../create-ack";

import { CANONICAL_PROJECTION_CONSUMERS } from "./projection-consumers";
import { runEventWakeBus } from "./run-wake";
import { applyWorkspaceEvidence, prepareWorkspaceEvidence } from "./workspace-prepare-projector";
import {
  ExecutionEventProjectionError,
  projectExecutionEvents,
  type ExecutionEventProjectorSummary,
  type ExecutionEventProjector,
} from "./projector";

import {
  executionAssignments,
  executionCommands,
  executionEvents,
  executionProjectionBackfills,
  runSessionIncarnations,
  runSessions,
  runs,
  type ExecutionEvent,
  type RunSessionIncarnation,
} from "@/lib/db/schema";

const log = pino({
  name: "lifecycle-projector",
  level: process.env.LOG_LEVEL ?? "info",
});

const CRASH_REPAIR_TAG = "0369_reconcile_skipped_session_crashes";
const CRASH_REPAIR_MARKER = `${CRASH_REPAIR_TAG}:post-cutover`;

// Run after the old Web writers have stopped. Migration 0369 can otherwise
// miss an event whose legacy lifecycle cursor advances during deployment.
export async function reconcileSkippedSessionCrashes(db: Db): Promise<number> {
  const count = await db.transaction(async (tx) => {
    const marker = await tx
      .insert(executionProjectionBackfills)
      .values({
        consumerName: CRASH_REPAIR_MARKER,
        completedAt: sql`clock_timestamp()`,
      })
      .onConflictDoNothing()
      .returning();

    if (marker.length === 0) return null;
    const migration = await readFile(
      join(process.cwd(), "lib", "db", "migrations", `${CRASH_REPAIR_TAG}.sql`),
      "utf8",
    );
    const repaired = await tx.execute(sql.raw(migration));

    return repaired.rowCount ?? 0;
  });

  if (count !== null) {
    log.info(
      { migration: CRASH_REPAIR_TAG, repaired: count },
      "[FIX] Reconciled skipped lifecycle crashes after Web cutover",
    );
  }

  return count ?? 0;
}

export const canonicalLifecycleProjector: ExecutionEventProjector = {
  consumerName: CANONICAL_PROJECTION_CONSUMERS.lifecycle,
  prepare: prepareWorkspaceEvidence,
  project: projectLifecycle,
  afterCommit(events) {
    const lifecycle = events.find(
      (event) =>
        event.eventType === "session.created" ||
        event.eventType === "session.exited" ||
        event.eventType === "session.crashed" ||
        event.eventType === "workspace.command.terminal",
    );

    if (lifecycle) runEventWakeBus.wake(lifecycle.runId);
  },
};

function permanent(message: string): ExecutionEventProjectionError {
  return new ExecutionEventProjectionError(message, true);
}

async function currentCanonicalAssignment(
  tx: Db,
  event: ExecutionEvent,
): Promise<boolean> {
  if (event.source !== "host") return false;
  if (
    !event.executionHostId ||
    !event.executionAssignmentId ||
    event.assignmentEpoch === null
  ) {
    throw permanent("canonical lifecycle event is missing an assignment fence");
  }
  const assignment = await lockCurrentSessionAssignment(tx, {
    runId: event.runId,
    assignmentId: event.executionAssignmentId,
  });

  return (
    assignment?.executionHostId === event.executionHostId &&
    assignment.epoch === event.assignmentEpoch
  );
}

function sessionName(payload: Record<string, unknown> | null): string {
  const value = payload?.sessionName;

  if (typeof value !== "string" || value.length === 0) {
    throw permanent("session lifecycle event is missing sessionName");
  }

  return value;
}

async function bindEventToIncarnation(
  tx: Db,
  event: ExecutionEvent,
  incarnationId: string,
): Promise<void> {
  await tx
    .update(executionEvents)
    .set({ runSessionIncarnationId: incarnationId })
    .where(eq(executionEvents.id, event.id));
}

async function projectCreated(tx: Db, event: ExecutionEvent): Promise<void> {
  if (
    !event.executionHostId ||
    !event.executionAssignmentId ||
    !event.hostSessionId ||
    event.assignmentEpoch === null
  ) {
    throw permanent("session.created event is missing host/session identity");
  }
  const name = sessionName(event.payload);
  const acpSessionId =
    typeof event.payload?.acpSessionId === "string"
      ? event.payload.acpSessionId
      : null;
  const steeringSupported =
    typeof event.payload?.steeringSupported === "boolean"
      ? event.payload.steeringSupported
      : null;
  const disposition = await applyCreateAck(tx, {
    ...(typeof event.payload?.createdByCommandId === "string"
      ? { commandId: event.payload.createdByCommandId }
      : {}),
    runId: event.runId,
    sessionName: name,
    assignmentId: event.executionAssignmentId,
    nodeAttemptId: null,
    result: { sessionId: event.hostSessionId, acpSessionId, steeringSupported },
  });

  let session = await lockLogicalRunSession(tx, {
    runId: event.runId,
    sessionName: name,
  });

  if (!session && disposition === "stale") {
    const [historical] = await tx
      .insert(runSessions)
      .values({ id: randomUUID(), runId: event.runId, sessionName: name })
      .returning();

    session = historical ?? null;
  }
  if (!session) throw permanent("created incarnation has no logical row");

  const existing = await tx
    .select()
    .from(runSessionIncarnations)
    .where(
      and(
        eq(runSessionIncarnations.executionHostId, event.executionHostId),
        eq(runSessionIncarnations.hostSessionId, event.hostSessionId),
      ),
    )
    .for("update")
    .limit(1);
  const incarnation = existing[0];

  if (incarnation) {
    if (
      incarnation.runId !== event.runId ||
      incarnation.runSessionId !== session.id
    ) {
      throw permanent(
        "host session incarnation belongs to another run session",
      );
    }
    // The create ACK wrote this row as `created`; the canonical event is what
    // proves the ACP session initialized, so it alone activates the row.
    if (incarnation.state === "created" && disposition === "applied") {
      await tx
        .update(runSessionIncarnations)
        .set({
          state: "active",
          activatedAt: event.occurredAt,
          hostBootId: event.hostBootId,
          acpSessionId: incarnation.acpSessionId ?? acpSessionId,
        })
        .where(eq(runSessionIncarnations.id, incarnation.id));
      log.info(
        { runId: event.runId, incarnationId: incarnation.id },
        "session-incarnation-activated",
      );
    } else if (incarnation.state === "created") {
      await tx
        .update(runSessionIncarnations)
        .set({
          state: "lost",
          endedAt: event.occurredAt,
          terminalReason: { reason: "create_owner_superseded" },
        })
        .where(eq(runSessionIncarnations.id, incarnation.id));
      log.warn(
        { runId: event.runId, incarnationId: incarnation.id },
        "session-incarnation-lost-on-stale-create",
      );
    }
    await bindEventToIncarnation(tx, event, incarnation.id);

    return;
  }

  const inserted = await tx
    .insert(runSessionIncarnations)
    .values({
      id: randomUUID(),
      runSessionId: session.id,
      runId: event.runId,
      executionAssignmentId: event.executionAssignmentId,
      assignmentEpoch: event.assignmentEpoch,
      executionHostId: event.executionHostId,
      hostSessionId: event.hostSessionId,
      hostBootId: event.hostBootId,
      acpSessionId,
      steeringSupported,
      state: disposition === "applied" ? "active" : "lost",
      origin: "native",
      createdAt: event.occurredAt,
      activatedAt: disposition === "applied" ? event.occurredAt : null,
      ...(disposition === "stale"
        ? {
            endedAt: event.occurredAt,
            terminalReason: { reason: "create_owner_superseded" },
          }
        : {}),
    })
    .returning();
  const created = inserted[0];

  if (!created)
    throw permanent("run session incarnation insert did not return a row");
  await bindEventToIncarnation(tx, event, created.id);
}

/** A process can exit before ACP initialization publishes session.created.
 * Preserve that incarnation using the exact creator command without granting
 * it authority over the current logical session binding.
 */
async function recordUninitializedTerminal(
  tx: Db,
  event: ExecutionEvent,
): Promise<RunSessionIncarnation> {
  const creatorId = event.payload?.createdByCommandId;

  if (
    !event.executionHostId ||
    !event.executionAssignmentId ||
    !event.hostSessionId ||
    event.assignmentEpoch === null ||
    typeof creatorId !== "string" ||
    creatorId.length === 0
  ) {
    throw permanent("terminal session event has no matching creator identity");
  }
  const name = sessionName(event.payload);
  const [creator] = await tx
    .select({ payload: executionCommands.payload })
    .from(executionCommands)
    .where(
      and(
        eq(executionCommands.id, creatorId),
        eq(executionCommands.kind, "session.create"),
        eq(executionCommands.runId, event.runId),
        eq(executionCommands.executionHostId, event.executionHostId),
        eq(
          executionCommands.executionAssignmentId,
          event.executionAssignmentId,
        ),
        eq(executionCommands.assignmentEpoch, event.assignmentEpoch),
      ),
    )
    .limit(1);

  if (!creator || creator.payload.sessionName !== name) {
    throw permanent(
      "terminal session creator does not match its run/session fence",
    );
  }
  if (event.payload?.reason === "checkpoint") {
    throw permanent(
      "checkpoint terminal event requires an initialized incarnation",
    );
  }
  const acpSessionId = event.payload?.acpSessionId;

  if (acpSessionId !== null && typeof acpSessionId !== "string") {
    throw permanent(
      "terminal session creator evidence is missing its ACP handle field",
    );
  }
  const existingSession = await lockLogicalRunSession(tx, {
    runId: event.runId,
    sessionName: name,
  });
  const sessionId = existingSession?.id ?? randomUUID();

  if (!existingSession) {
    await tx.insert(runSessions).values({
      id: sessionId,
      runId: event.runId,
      sessionName: name,
      createdAt: event.occurredAt,
      updatedAt: event.occurredAt,
    });
  }
  const [incarnation] = await tx
    .insert(runSessionIncarnations)
    .values({
      id: randomUUID(),
      runSessionId: sessionId,
      runId: event.runId,
      executionAssignmentId: event.executionAssignmentId,
      assignmentEpoch: event.assignmentEpoch,
      executionHostId: event.executionHostId,
      hostSessionId: event.hostSessionId,
      hostBootId: event.hostBootId,
      acpSessionId,
      state: event.eventType === "session.crashed" ? "crashed" : "exited",
      origin: "native",
      createdAt: event.occurredAt,
      endedAt: event.occurredAt,
      terminalReason: event.payload,
    })
    .returning();

  if (!incarnation)
    throw permanent("terminal incarnation insert did not return a row");

  return incarnation;
}

async function projectTerminal(tx: Db, event: ExecutionEvent): Promise<void> {
  if (!event.executionHostId || !event.hostSessionId) {
    throw permanent("terminal session event is missing host session identity");
  }
  const rows = await tx
    .select()
    .from(runSessionIncarnations)
    .where(
      and(
        eq(runSessionIncarnations.executionHostId, event.executionHostId),
        eq(runSessionIncarnations.hostSessionId, event.hostSessionId),
      ),
    )
    .for("update")
    .limit(1);
  const incarnation = rows[0] ?? (await recordUninitializedTerminal(tx, event));

  if (incarnation.runId !== event.runId) {
    throw permanent("terminal session event has no matching incarnation");
  }
  await applyTerminalToIncarnation(tx, event, incarnation);
}

async function applyTerminalToIncarnation(
  tx: Db,
  event: ExecutionEvent,
  incarnation: RunSessionIncarnation,
): Promise<void> {
  const checkpointed =
    event.eventType === "session.exited" &&
    event.payload?.reason === "checkpoint";
  const nextState =
    event.eventType === "session.crashed"
      ? "crashed"
      : checkpointed
        ? "checkpointed"
        : "exited";

  // Only an open row may become checkpointed: a superseded (`lost`) or ended
  // row re-entering the open set would collide with its successor on the
  // one-open-row-per-session index and poison this projector permanently.
  if (
    nextState === "checkpointed" &&
    !(ADMISSIBLE_PROMPT_INCARNATION_STATES as readonly string[]).includes(
      incarnation.state,
    )
  ) {
    await tx
      .update(runSessionIncarnations)
      .set({ terminalReason: event.payload ?? {} })
      .where(eq(runSessionIncarnations.id, incarnation.id));
    log.warn(
      {
        runId: event.runId,
        incarnationId: incarnation.id,
        state: incarnation.state,
        eventType: event.eventType,
      },
      "session-incarnation-terminal-on-superseded",
    );
  } else if (incarnation.state !== nextState) {
    await tx
      .update(runSessionIncarnations)
      .set({
        state: nextState,
        endedAt: checkpointed ? null : event.occurredAt,
        terminalReason: event.payload ?? {},
      })
      .where(eq(runSessionIncarnations.id, incarnation.id));
  }
  await bindEventToIncarnation(tx, event, incarnation.id);
}

async function projectReleasedSessionCrash(
  tx: Db,
  event: ExecutionEvent,
): Promise<void> {
  if (
    event.source !== "host" ||
    !event.executionHostId ||
    !event.executionAssignmentId ||
    event.assignmentEpoch === null ||
    !event.hostSessionId
  )
    return;

  const [incarnation] = await tx
    .select()
    .from(runSessionIncarnations)
    .where(
      and(
        eq(runSessionIncarnations.runId, event.runId),
        eq(runSessionIncarnations.executionHostId, event.executionHostId),
        eq(
          runSessionIncarnations.executionAssignmentId,
          event.executionAssignmentId,
        ),
        eq(runSessionIncarnations.assignmentEpoch, event.assignmentEpoch),
        eq(runSessionIncarnations.hostSessionId, event.hostSessionId),
        inArray(runSessionIncarnations.state, [
          "created",
          "active",
          "lost",
          "crashed",
        ]),
      ),
    )
    .for("update");

  if (!incarnation) return;
  if (
    event.runSessionIncarnationId !== null &&
    event.runSessionIncarnationId !== incarnation.id
  ) {
    throw permanent("historical crash is bound to another incarnation");
  }
  await applyTerminalToIncarnation(tx, event, incarnation);
}

function ownedCheckpointReceipt(db: Db) {
  return and(
    eq(executionEvents.eventType, "session.command"),
    eq(executionEvents.payloadSchema, "maister.session.command.v1"),
    sql`${executionEvents.payload}->>'kind' = 'session.checkpoint'
      AND ${executionEvents.payload}->>'phase' = 'completed'
      AND ${executionEvents.payload}->>'status' = 'succeeded'
      AND ${executionEvents.payload}->'result'->>'sessionId' = ${executionEvents.hostSessionId}`,
    exists(
      db
        .select({ id: executionCommands.id })
        .from(executionCommands)
        .where(
          and(
            sql`${executionCommands.id} = ${executionEvents.payload}->>'commandId'`,
            eq(executionCommands.kind, "session.checkpoint"),
            eq(executionCommands.runId, executionEvents.runId),
            eq(
              executionCommands.executionAssignmentId,
              executionEvents.executionAssignmentId,
            ),
            eq(
              executionCommands.assignmentEpoch,
              executionEvents.assignmentEpoch,
            ),
            eq(
              executionCommands.executionHostId,
              executionEvents.executionHostId,
            ),
            eq(
              executionCommands.targetSessionId,
              executionEvents.hostSessionId,
            ),
          ),
        ),
    ),
  );
}

async function projectCheckpointReceipt(
  tx: Db,
  event: ExecutionEvent,
): Promise<void> {
  const [receipt] = await tx
    .select({ id: executionEvents.id })
    .from(executionEvents)
    .where(and(eq(executionEvents.id, event.id), ownedCheckpointReceipt(tx)));
  if (!receipt) return;

  const [changed] = await tx
    .update(runSessionIncarnations)
    .set({
      state: "checkpointed",
      terminalReason: { reason: "checkpoint" },
    })
    .where(
      and(
        eq(runSessionIncarnations.runId, event.runId),
        eq(
          runSessionIncarnations.executionAssignmentId,
          event.executionAssignmentId!,
        ),
        eq(runSessionIncarnations.assignmentEpoch, event.assignmentEpoch!),
        eq(runSessionIncarnations.executionHostId, event.executionHostId!),
        eq(runSessionIncarnations.hostSessionId, event.hostSessionId!),
        inArray(runSessionIncarnations.state, ["created", "active"]),
      ),
    )
    .returning({ id: runSessionIncarnations.id });
  if (changed) await bindEventToIncarnation(tx, event, changed.id);
}

/** Reconcile exact host exits even if their original projection cursor advanced. */
export async function reconcileHistoricalAgentLifecycle(
  db: Db,
  runId: string,
): Promise<number> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select({
        event: executionEvents,
        incarnationId: runSessionIncarnations.id,
        incarnationState: runSessionIncarnations.state,
      })
      .from(runSessionIncarnations)
      .innerJoin(
        executionAssignments,
        eq(
          executionAssignments.id,
          runSessionIncarnations.executionAssignmentId,
        ),
      )
      .innerJoin(
        executionEvents,
        and(
          eq(executionEvents.runId, runSessionIncarnations.runId),
          eq(
            executionEvents.executionAssignmentId,
            runSessionIncarnations.executionAssignmentId,
          ),
          eq(
            executionEvents.assignmentEpoch,
            runSessionIncarnations.assignmentEpoch,
          ),
          eq(
            executionEvents.executionHostId,
            runSessionIncarnations.executionHostId,
          ),
          eq(
            executionEvents.hostSessionId,
            runSessionIncarnations.hostSessionId,
          ),
        ),
      )
      .where(
        and(
          eq(runSessionIncarnations.runId, runId),
          ne(executionAssignments.state, "active"),
          inArray(runSessionIncarnations.state, ["created", "active", "lost"]),
          eq(executionEvents.source, "host"),
          inArray(executionEvents.ingestDisposition, [
            "accepted",
            "stale_epoch",
          ]),
          or(
            inArray(executionEvents.eventType, [
              "session.exited",
              "session.crashed",
            ]),
            ownedCheckpointReceipt(tx),
          ),
        ),
      )
      .orderBy(asc(executionEvents.hostSequence), asc(executionEvents.id))
      .limit(32);

    let repaired = 0;
    for (const { event, incarnationId, incarnationState } of rows) {
      const checkpointed =
        (event.eventType === "session.command" ||
          (event.eventType === "session.exited" &&
            event.payload?.reason === "checkpoint")) &&
        incarnationState !== "lost";
      // A lost row was retired to permit a successor. Exact checkpoint
      // evidence proves its exit without reopening the logical session slot.
      const changed = await tx
        .update(runSessionIncarnations)
        .set({
          state:
            event.eventType === "session.crashed"
              ? "crashed"
              : checkpointed
                ? "checkpointed"
                : "exited",
          endedAt: event.occurredAt,
          terminalReason:
            event.eventType === "session.command"
              ? { reason: "checkpoint" }
              : (event.payload ?? {}),
        })
        .where(
          and(
            eq(runSessionIncarnations.id, incarnationId),
            eq(runSessionIncarnations.state, incarnationState),
          ),
        )
        .returning({ id: runSessionIncarnations.id });
      if (changed.length) {
        repaired += 1;
        log.info(
          { runId, incarnationId, eventId: event.id },
          "historical-session-incarnation-settled",
        );
      }
    }
    return repaired;
  });
}

async function projectLifecycle(tx: Db, event: ExecutionEvent): Promise<void> {
  if (event.eventType === "workspace.command.terminal") {
    await applyWorkspaceEvidence(tx, event);

    return;
  }
  if (
    event.eventType === "session.command" &&
    event.payload?.kind === "session.checkpoint" &&
    event.payload.phase === "completed" &&
    event.payload.status === "succeeded"
  ) {
    if (await currentCanonicalAssignment(tx, event))
      await projectCheckpointReceipt(tx, event);
    return;
  }
  if (
    event.eventType !== "session.created" &&
    event.eventType !== "session.exited" &&
    event.eventType !== "session.crashed"
  ) {
    return;
  }
  if (!(await currentCanonicalAssignment(tx, event))) {
    // Ingest already accepted this event. A prompt owner may have released the
    // assignment while this independent cursor was waiting to project it.
    if (event.eventType === "session.crashed")
      await projectReleasedSessionCrash(tx, event);

    return;
  }
  if (event.eventType === "session.created") {
    await projectCreated(tx, event);

    return;
  }
  await projectTerminal(tx, event);
}

export async function projectCanonicalSessionLifecycle(input: {
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
    projector: canonicalLifecycleProjector,
  });
}

export async function projectPendingCanonicalSessionLifecycle(input: {
  db: Db;
  batchSize?: number;
}): Promise<number> {
  const runRows = await input.db.select({ id: runs.id }).from(runs);
  let projected = 0;

  for (const run of runRows) {
    const summary = await projectCanonicalSessionLifecycle({
      db: input.db,
      runId: run.id,
      batchSize: input.batchSize,
    });

    projected += summary.projected;
  }

  return projected;
}
