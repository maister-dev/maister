import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { LaunchAgentRunInput } from "./launch";
import type { TaskLaunchServerSourceSnapshot } from "@/lib/tasks/launch-server-source";

import { and, eq, isNull, ne, sql } from "drizzle-orm";

import { parseScheduledRequestSnapshot } from "./scheduled-request";
import { retryDigest } from "./retry-guards";

import {
  agentTriggerAttempts,
  agentSchedules,
  taskLaunchIntents,
  runs,
} from "@/lib/db/schema";
import { launchRefusal } from "@/lib/tasks/launch-resolution";

type Intent = typeof taskLaunchIntents.$inferSelect;
type Attempt = typeof agentTriggerAttempts.$inferSelect;

/** Recover the actual durable fire reservation; caller-supplied run IDs alone carry no allocation authority. */
export async function loadTaskAgentTriggerReservation(
  db: Db,
  input: LaunchAgentRunInput,
): Promise<Attempt | null> {
  const requestedRunId = input.runId ?? input.agentTriggerReservation?.runId;

  if (!requestedRunId) return null;
  const [attempt] = await db
    .select()
    .from(agentTriggerAttempts)
    .where(
      and(
        eq(agentTriggerAttempts.reservedRunId, requestedRunId),
        eq(agentTriggerAttempts.projectId, input.projectId),
        eq(agentTriggerAttempts.sourceAgentId, input.agentId),
      ),
    );

  if (
    !attempt ||
    attempt.triggerSource !== input.trigger.source ||
    attempt.triggerEventId !== (input.trigger.eventId ?? null) ||
    (input.agentTriggerReservation &&
      (attempt.id !== input.agentTriggerReservation.attemptId ||
        attempt.reservedRunId !== input.agentTriggerReservation.runId))
  )
    throw launchRefusal("launch_source_authority_required", "PRECONDITION");

  return attempt;
}

async function sourceAttempt(
  db: Db,
  source: TaskLaunchServerSourceSnapshot,
): Promise<Attempt | null> {
  const reservation = source.execution.agentTriggerReservation;

  if (!reservation) return null;
  const [attempt] = await db
    .select()
    .from(agentTriggerAttempts)
    .where(
      and(
        eq(agentTriggerAttempts.id, reservation.attemptId),
        eq(agentTriggerAttempts.reservedRunId, reservation.runId),
        eq(agentTriggerAttempts.projectId, source.projectId),
        eq(agentTriggerAttempts.sourceAgentId, source.execution.agentId ?? ""),
      ),
    );

  if (
    !attempt ||
    attempt.triggerSource !== source.execution.triggerSource ||
    attempt.triggerEventId !== (source.execution.triggerEventId ?? null) ||
    retryDigest(
      parseScheduledRequestSnapshot(attempt.scheduledRequestSnapshot),
    ) !== retryDigest(source.execution.scheduledRequestSnapshot ?? null)
  )
    throw launchRefusal("launch_source_changed", "PRECONDITION");

  return attempt;
}

/** A committed intent, rather than an expired producer lease, owns an accepted invocation. */
export async function assertTaskAgentTriggerReservation(
  db: Db,
  source: TaskLaunchServerSourceSnapshot,
): Promise<void> {
  const attempt = await sourceAttempt(db, source);

  if (!attempt) return;
  const [owner] = await db
    .select()
    .from(taskLaunchIntents)
    .where(
      and(
        eq(taskLaunchIntents.projectId, source.projectId),
        eq(taskLaunchIntents.taskId, source.taskId),
        eq(taskLaunchIntents.principalKind, "system"),
        eq(taskLaunchIntents.principalId, `${source.kind}:${source.id}`),
        sql`${taskLaunchIntents.settingsSnapshot}->'serverExecution'->'execution'->'agentTriggerReservation'->>'attemptId'=${attempt.id}`,
      ),
    )
    .limit(1);

  if (
    owner &&
    owner.settingsSnapshot.version === 2 &&
    retryDigest(owner.settingsSnapshot.serverExecution) === retryDigest(source)
  )
    return;
  if (attempt.outcome !== null || attempt.dueAt.getTime() <= Date.now())
    throw launchRefusal("launch_source_unavailable", "PRECONDITION");
}

/** The source acknowledgement commits with acceptance; producer recovery cannot label accepted work unknown. */
export async function recordTaskAgentTriggerIntentAccepted(
  db: Db,
  intent: Intent,
): Promise<void> {
  const source =
    intent.settingsSnapshot.version === 2
      ? intent.settingsSnapshot.serverExecution
      : null;

  if (
    !source ||
    source.kind !== "agent_trigger" ||
    !source.execution.agentTriggerReservation
  )
    return;
  const attempt = await sourceAttempt(db, source);

  if (!attempt)
    throw launchRefusal("launch_source_authority_required", "PRECONDITION");
  const [current] = await db
    .select()
    .from(agentTriggerAttempts)
    .where(eq(agentTriggerAttempts.id, attempt.id))
    .for("update");

  if (
    !current ||
    (current.outcome !== null && current.outcome !== "queued") ||
    (current.outcome === null && current.dueAt.getTime() <= Date.now())
  )
    throw launchRefusal("launch_source_unavailable", "PRECONDITION");
  const [otherOwner] = await db
    .select({ id: taskLaunchIntents.id })
    .from(taskLaunchIntents)
    .where(
      and(
        ne(taskLaunchIntents.id, intent.id),
        sql`${taskLaunchIntents.settingsSnapshot}->'serverExecution'->'execution'->'agentTriggerReservation'->>'attemptId'=${attempt.id}`,
      ),
    )
    .limit(1);

  if (otherOwner)
    throw launchRefusal("launch_source_already_owned", "CONFLICT");
  if (current.outcome === "queued") return;
  const acceptedAt = new Date();

  await db
    .update(agentTriggerAttempts)
    .set({
      outcome: "queued",
      settledAt: acceptedAt,
      runId: null,
      originalRunId: null,
      reasonCode: null,
    })
    .where(
      and(
        eq(agentTriggerAttempts.id, attempt.id),
        eq(agentTriggerAttempts.fence, attempt.fence),
        isNull(agentTriggerAttempts.outcome),
      ),
    );
  await db
    .update(agentSchedules)
    .set({
      lastOutcome: "queued",
      lastRunId: null,
      lastErrorCode: null,
      lastErrorMessage: null,
      updatedAt: acceptedAt,
    })
    .where(
      and(
        eq(agentSchedules.id, attempt.scheduleId),
        eq(agentSchedules.lastAttemptFence, attempt.fence),
      ),
    );
}

/** Link only the reserved real Run after it exists; a queued intent never masquerades as a Run. */
export async function recordTaskAgentTriggerRunBound(
  db: Db,
  intent: Intent,
  runId: string,
): Promise<void> {
  const source =
    intent.settingsSnapshot.version === 2
      ? intent.settingsSnapshot.serverExecution
      : null;

  if (
    !source ||
    source.kind !== "agent_trigger" ||
    !source.execution.agentTriggerReservation
  )
    return;
  const attempt = await sourceAttempt(db, source);
  const [run] = await db
    .select()
    .from(runs)
    .where(
      and(
        eq(runs.id, runId),
        eq(runs.taskLaunchIntentId, intent.id),
        eq(runs.projectId, intent.projectId),
        eq(runs.taskId, intent.taskId),
      ),
    );

  if (
    !attempt ||
    attempt.reservedRunId !== runId ||
    !run ||
    run.sourceAgentId !== source.execution.agentId ||
    retryDigest(run.scheduledRequestSnapshot) !==
      retryDigest(
        parseScheduledRequestSnapshot(attempt.scheduledRequestSnapshot),
      )
  )
    throw launchRefusal("launch_source_changed", "PRECONDITION");
  await db
    .update(agentTriggerAttempts)
    .set({ runId, originalRunId: runId })
    .where(
      and(
        eq(agentTriggerAttempts.id, attempt.id),
        eq(agentTriggerAttempts.outcome, "queued"),
      ),
    );
  await db
    .update(agentSchedules)
    .set({ lastRunId: runId })
    .where(
      and(
        eq(agentSchedules.id, attempt.scheduleId),
        eq(agentSchedules.lastAttemptFence, attempt.fence),
      ),
    );
}
