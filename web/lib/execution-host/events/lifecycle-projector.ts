import "server-only";

import type { Db } from "@/lib/execution-host/db";

import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";

import {
  ExecutionEventProjectionError,
  projectExecutionEvents,
  type ExecutionEventProjectorSummary,
} from "./projector";

import {
  executionAssignments,
  executionEvents,
  runSessionIncarnations,
  runSessions,
  runs,
  type ExecutionEvent,
} from "@/lib/db/schema";

const LIFECYCLE_CONSUMER_NAME = "canonical-session-lifecycle-v1";

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
  const runRows = await tx
    .select({ executionDataPlaneMode: runs.executionDataPlaneMode })
    .from(runs)
    .where(eq(runs.id, event.runId))
    .limit(1);

  if (!runRows[0])
    throw permanent("canonical lifecycle event references a missing run");
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

function sessionName(payload: Record<string, unknown> | null): string {
  const value = payload?.sessionName;

  if (typeof value !== "string" || value.length === 0) {
    throw permanent("session.created event is missing sessionName");
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
    !event.hostSessionId
  ) {
    throw permanent("session.created event is missing host/session identity");
  }
  const name = sessionName(event.payload);
  const acpSessionId =
    typeof event.payload?.acpSessionId === "string"
      ? event.payload.acpSessionId
      : null;
  const sessions = await tx
    .select()
    .from(runSessions)
    .where(
      and(
        eq(runSessions.runId, event.runId),
        eq(runSessions.sessionName, name),
      ),
    )
    .for("update")
    .limit(1);
  let session = sessions[0];

  if (!session) {
    const inserted = await tx
      .insert(runSessions)
      .values({ id: randomUUID(), runId: event.runId, sessionName: name })
      .returning();

    session = inserted[0];
  }
  if (!session) throw permanent("run session insert did not return a row");

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
      state: "active",
      origin: "native",
      createdAt: event.occurredAt,
      activatedAt: event.occurredAt,
    })
    .returning();
  const created = inserted[0];

  if (!created)
    throw permanent("run session incarnation insert did not return a row");
  await tx
    .update(runSessions)
    .set({
      executionAssignmentId: event.executionAssignmentId,
      hostSessionId: event.hostSessionId,
      ...(acpSessionId ? { acpSessionId } : {}),
      updatedAt: event.receivedAt,
    })
    .where(eq(runSessions.id, session.id));
  await bindEventToIncarnation(tx, event, created.id);
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
  const incarnation = rows[0];

  if (!incarnation || incarnation.runId !== event.runId) {
    throw permanent("terminal session event has no matching incarnation");
  }
  const checkpointed =
    event.eventType === "session.exited" &&
    event.payload?.reason === "checkpoint";
  const nextState =
    event.eventType === "session.crashed"
      ? "crashed"
      : checkpointed
        ? "checkpointed"
        : "exited";

  if (incarnation.state !== nextState) {
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

async function projectLifecycle(tx: Db, event: ExecutionEvent): Promise<void> {
  if (
    event.eventType !== "session.created" &&
    event.eventType !== "session.exited" &&
    event.eventType !== "session.crashed"
  ) {
    return;
  }
  if (!(await currentCanonicalAssignment(tx, event))) return;
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
    projector: {
      consumerName: LIFECYCLE_CONSUMER_NAME,
      project: projectLifecycle,
    },
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
