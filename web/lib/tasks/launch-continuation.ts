import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { DomainEventActor } from "@/lib/domain-events/outbox";
import type { InteractiveTaskLaunchPrincipal } from "./admission-types";
import type { TokenTaskLaunchPrincipal } from "./launch-token";

import { and, asc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { z } from "zod";
import pino from "pino";

import { launchRefusal } from "./launch-resolution";
import { assertInteractiveTaskLaunchPrincipal } from "./admission-types";
import { assertTaskLaunchUserAuthority } from "./launch-authority";
import {
  assertTokenTaskLaunchPrincipal,
  assertTaskLaunchRecoveryTokenAuthority,
  taskLaunchTokenActorUserId,
} from "./launch-token";
import { lockTaskLaunchReservation } from "./launch-locks";
import { emitTaskLaunchChanged } from "./launch-events";

import {
  executionAssignments,
  runs,
  tasks,
  taskLaunchIntents,
} from "@/lib/db/schema";
import { retryDigest } from "@/lib/agents/retry-guards";
import {
  loadFlowScheduledRequestSource,
  loadAgentBudgetRestartRequest,
} from "@/lib/agents/scheduled-request-lineage";
import { scheduledRequestSnapshotSchema } from "@/lib/agents/scheduled-request";
import { deriveEvaluationParticipationFromSource } from "@/lib/evaluations/membership";
import { isSettledRunStatus } from "@/lib/runs/run-status-sets";
import { MaisterError } from "@/lib/errors";

const identifier = z.string().min(1).max(256);
const log = pino({
  name: "task-launch-continuation",
  level: process.env.LOG_LEVEL ?? "info",
});
const evaluationSourceSchema = z
  .object({
    studyId: identifier,
    recipeId: identifier.nullable(),
    replicateGroup: z.string().nullable(),
    sourceRemoved: z.boolean(),
  })
  .strict();

export const taskLaunchRelaunchSourceSchema = z
  .object({
    version: z.literal(1),
    runId: identifier,
    projectId: identifier,
    taskId: identifier,
    flowId: identifier.nullable(),
    flowRevisionId: identifier.nullable(),
    packageInstallId: identifier.nullable(),
    agentId: identifier.nullable(),
    scheduledRequestSnapshot: scheduledRequestSnapshotSchema.nullable(),
    evaluation: evaluationSourceSchema.nullable(),
  })
  .strict();
export type TaskLaunchRelaunchSource = z.infer<
  typeof taskLaunchRelaunchSourceSchema
>;
type RelaunchSourceSelector = Readonly<{
  sourceRunId: string;
  projectId: string;
  taskId: string;
}>;

async function scopedRelaunchSource(
  db: Db,
  input: RelaunchSourceSelector,
): Promise<typeof runs.$inferSelect> {
  const [source] = await db
    .select()
    .from(runs)
    .where(eq(runs.id, input.sourceRunId));

  if (
    !source ||
    source.projectId !== input.projectId ||
    source.taskId !== input.taskId ||
    (source.runKind !== "flow" &&
      (source.runKind !== "agent" ||
        source.agentKind === "operational" ||
        !source.agentId))
  ) {
    throw launchRefusal("launch_source_unavailable", "PRECONDITION");
  }

  return source;
}

async function snapshotRelaunchSource(
  db: Db,
  source: typeof runs.$inferSelect,
): Promise<TaskLaunchRelaunchSource> {
  if (!source.taskId || !source.projectId)
    throw launchRefusal("launch_source_unavailable", "PRECONDITION");
  const selector = {
    sourceRunId: source.id,
    projectId: source.projectId,
    taskId: source.taskId,
  };
  const agentRequest =
    source.runKind === "agent" && source.agentId
      ? await loadAgentBudgetRestartRequest(db, {
          ...selector,
          agentId: source.agentId,
        })
      : null;
  const scheduled =
    source.runKind === "flow"
      ? await loadFlowScheduledRequestSource(db, selector)
      : agentRequest && source.agentId
        ? { snapshot: agentRequest, agentId: source.agentId }
        : null;
  const evaluation = await deriveEvaluationParticipationFromSource(db, {
    sourceRunId: source.id,
    taskId: source.taskId,
  });
  const [origin] = source.taskLaunchIntentId
    ? await db
        .select()
        .from(taskLaunchIntents)
        .where(eq(taskLaunchIntents.id, source.taskLaunchIntentId))
    : [];
  const result = taskLaunchRelaunchSourceSchema.safeParse({
    version: 1,
    runId: source.id,
    projectId: source.projectId,
    taskId: source.taskId,
    flowId: source.flowId,
    flowRevisionId: source.flowRevisionId,
    packageInstallId: origin?.settingsSnapshot.packageInstallId ?? null,
    agentId: source.agentId,
    scheduledRequestSnapshot: scheduled?.snapshot ?? null,
    // Labels and ordinals are derived allocation/presentation, not source identity.
    evaluation: evaluation
      ? {
          studyId: evaluation.studyId,
          recipeId: evaluation.recipeId,
          replicateGroup: evaluation.replicateGroup,
          sourceRemoved: evaluation.sourceRemoved,
        }
      : null,
  });

  if (!result.success)
    throw launchRefusal("launch_source_snapshot_incomplete", "PRECONDITION");

  return result.data;
}

/** Ordinary successors cannot borrow a still-active run's launch authority. */
export async function captureTaskLaunchRelaunchSource(
  db: Db,
  input: RelaunchSourceSelector,
): Promise<TaskLaunchRelaunchSource> {
  const source = await scopedRelaunchSource(db, input);

  if (!isSettledRunStatus(source.status))
    throw launchRefusal("launch_source_status_invalid", "PRECONDITION");

  return snapshotRelaunchSource(db, source);
}

/** The separate server-side concurrent authority must be established by the caller. */
export async function captureConcurrentTaskLaunchRelaunchSource(
  db: Db,
  input: RelaunchSourceSelector,
): Promise<TaskLaunchRelaunchSource> {
  return snapshotRelaunchSource(db, await scopedRelaunchSource(db, input));
}

export async function assertTaskLaunchRelaunchSource(
  db: Db,
  accepted: TaskLaunchRelaunchSource,
): Promise<void> {
  const current = await snapshotRelaunchSource(
    db,
    await scopedRelaunchSource(db, {
      sourceRunId: accepted.runId,
      projectId: accepted.projectId,
      taskId: accepted.taskId,
    }),
  );

  if (retryDigest(current) !== retryDigest(accepted))
    throw launchRefusal("launch_source_changed", "PRECONDITION");
}

const recoveryAuthority = Symbol("task launch continuation authority");

export type TaskLaunchRecoveryAuthority = Readonly<{
  [recoveryAuthority]: true;
  actor: DomainEventActor;
  assert: (db: Db, projectId: string) => Promise<void>;
}>;

export function interactiveTaskLaunchRecoveryAuthority(
  principal: InteractiveTaskLaunchPrincipal,
): TaskLaunchRecoveryAuthority {
  assertInteractiveTaskLaunchPrincipal(principal);

  return {
    [recoveryAuthority]: true,
    actor: { type: "user", id: principal.userId },
    assert: (db, projectId) =>
      assertTaskLaunchUserAuthority(db, projectId, principal.userId, [
        "recoverRun",
      ]),
  };
}

export function tokenTaskLaunchRecoveryAuthority(
  principal: TokenTaskLaunchPrincipal,
): TaskLaunchRecoveryAuthority {
  assertTokenTaskLaunchPrincipal(principal);
  const ownerId = taskLaunchTokenActorUserId(principal.origin);

  return {
    [recoveryAuthority]: true,
    actor: ownerId
      ? { type: "user", id: ownerId }
      : principal.origin.agentId
        ? { type: "agent", id: principal.origin.agentId }
        : { type: "system", id: null },
    assert: (db, projectId) =>
      assertTaskLaunchRecoveryTokenAuthority(db, principal, projectId),
  };
}

export type PreparedTaskLaunchRecovery =
  | Readonly<{ kind: "conflict" | "unresumable" }>
  | Readonly<{ kind: "prepared"; apply: () => Promise<void> }>;

/** Caller holds the scheduler lock. Publish only together with the successful same-run recovery CAS. */
export async function prepareTaskLaunchRecovery(
  db: Db,
  runId: string,
  authority: TaskLaunchRecoveryAuthority | undefined,
): Promise<PreparedTaskLaunchRecovery | null> {
  const [navigation] = await db
    .select({
      intentId: runs.taskLaunchIntentId,
      taskId: runs.taskId,
      projectId: runs.projectId,
    })
    .from(runs)
    .where(eq(runs.id, runId));

  if (!navigation?.intentId) return null;
  if (!authority || authority[recoveryAuthority] !== true) {
    throw new MaisterError(
      "UNAUTHORIZED",
      "Current authenticated recovery authority is required",
      { details: { reason: "launch_recovery_authority_required" } },
    );
  }
  if (!navigation.taskId || !navigation.projectId)
    return { kind: "unresumable" };
  await authority.assert(db, navigation.projectId);
  await lockTaskLaunchReservation(db, navigation.taskId);
  const [run] = await db
    .select()
    .from(runs)
    .where(eq(runs.id, runId))
    .for("update");

  await db
    .select({ id: executionAssignments.id })
    .from(executionAssignments)
    .where(eq(executionAssignments.runId, runId))
    .orderBy(asc(executionAssignments.id))
    .for("update");
  const [intent] = await db
    .select()
    .from(taskLaunchIntents)
    .where(eq(taskLaunchIntents.id, navigation.intentId))
    .for("update");

  await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(eq(tasks.id, navigation.taskId))
    .for("update");
  if (!run || run.status !== "Crashed") return null;
  if (
    !intent ||
    intent.runId !== run.id ||
    intent.originalRunId !== run.id ||
    intent.taskId !== run.taskId ||
    intent.projectId !== run.projectId ||
    run.taskLaunchIntentId !== intent.id
  )
    return { kind: "unresumable" };
  const [reserved] = await db
    .select({ id: taskLaunchIntents.id })
    .from(taskLaunchIntents)
    .where(
      and(
        eq(taskLaunchIntents.taskId, intent.taskId),
        ne(taskLaunchIntents.id, intent.id),
        eq(taskLaunchIntents.reservationLane, "ordinary"),
        inArray(taskLaunchIntents.state, [
          "queued",
          "preparing",
          "run_bound",
          "held",
        ]),
      ),
    )
    .limit(1);
  const [legacyOwner] = await db
    .select({ id: runs.id })
    .from(runs)
    .where(
      and(
        eq(runs.taskId, intent.taskId),
        ne(runs.id, run.id),
        isNull(runs.taskLaunchIntentId),
        inArray(runs.runKind, ["flow", "agent"]),
        sql`${runs.agentKind} IS DISTINCT FROM 'operational'`,
        inArray(runs.status, [
          "Pending",
          "Running",
          "NeedsInput",
          "NeedsInputIdle",
          "HumanWorking",
          "WaitingOnChildren",
        ]),
      ),
    )
    .limit(1);

  if (reserved || legacyOwner) return { kind: "conflict" };
  const witness = intent.dispatchReceipt;

  if (
    intent.state !== "settled" ||
    intent.terminalOutcome !== "Crashed" ||
    !intent.dispatchCommittedAt ||
    !witness ||
    witness.runId !== run.id ||
    witness.inputDigest !== intent.inputDigest ||
    witness.settingsDigest !== intent.settingsDigest ||
    intent.inputSnapshot.version !== 2 ||
    intent.settingsSnapshot.version !== 2 ||
    retryDigest(intent.inputSnapshot) !== intent.inputDigest ||
    retryDigest(intent.settingsSnapshot) !== intent.settingsDigest ||
    run.taskAdmissionSnapshot?.version !== 2 ||
    run.taskAdmissionSnapshot.intentId !== intent.id ||
    run.taskAdmissionSnapshot.basis !== intent.basis.kind
  )
    return { kind: "unresumable" };

  return {
    kind: "prepared",
    apply: async () => {
      const [reacquired] = await db
        .update(taskLaunchIntents)
        .set({
          state: "run_bound",
          stateVersion: intent.stateVersion + 1,
          terminalOutcome: null,
          reason: null,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(
          and(
            eq(taskLaunchIntents.id, intent.id),
            eq(taskLaunchIntents.state, "settled"),
            eq(taskLaunchIntents.stateVersion, intent.stateVersion),
          ),
        )
        .returning();

      if (!reacquired) throw launchRefusal("launch_worker_fenced");
      await emitTaskLaunchChanged(db, reacquired, authority.actor);
      log.info(
        {
          runId,
          intentId: intent.id,
          basis: intent.basis.kind,
          stateVersion: reacquired.stateVersion,
          firstDispatchAssignmentId: witness.assignmentId,
          firstDispatchEpoch: witness.assignmentEpoch,
        },
        "[FIX:LA08] same-run recovery reacquired its task reservation",
      );
    },
  };
}
