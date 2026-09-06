import "server-only";

import type { Db } from "@/lib/execution-host/db";

import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";

import {
  lockCurrentSessionAssignment,
  lockLogicalRunSession,
} from "../session-binding";
import { applyCreateAck } from "../create-ack";

import { CANONICAL_PROJECTION_CONSUMERS } from "./projection-consumers";
import {
  ExecutionEventProjectionError,
  projectExecutionEvents,
  type ExecutionEventProjectorSummary,
  type ExecutionEventProjector,
} from "./projector";

import {
  executionCommands,
  executionEvents,
  runSessionIncarnations,
  runSessions,
  runs,
  type ExecutionEvent,
  type RunSessionIncarnation,
} from "@/lib/db/schema";

export const canonicalLifecycleProjector: ExecutionEventProjector = {
  consumerName: CANONICAL_PROJECTION_CONSUMERS.lifecycle,
  project: projectLifecycle,
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
  const disposition = await applyCreateAck(tx, {
    runId: event.runId,
    sessionName: name,
    assignmentId: event.executionAssignmentId,
    nodeAttemptId: null,
    result: { sessionId: event.hostSessionId, acpSessionId },
  });

  if (disposition === "stale") return;
  const session = await lockLogicalRunSession(tx, {
    runId: event.runId,
    sessionName: name,
  });

  if (!session) throw permanent("applied session binding has no logical row");

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
