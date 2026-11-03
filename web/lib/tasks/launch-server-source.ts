import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { LaunchAgentRunInput } from "@/lib/agents/launch";
import type { LaunchRunInput } from "@/lib/services/runs";
import type { TaskLaunchReceipt } from "./launch-types";

import { and, eq } from "drizzle-orm";

import { launchRefusal } from "./launch-resolution";
import { taskLaunchReceipt } from "./launch-receipt";

import { taskLaunchIntents } from "@/lib/db/schema";

const serverSourceAuthority = Symbol("database-owned task launch source");

export type TaskLaunchServerSourceKind =
  | "scheduled_job"
  | "run_schedule"
  | "scheduled_task"
  | "agent_trigger"
  | "evaluation"
  | "budget_restart"
  | "ralph_retry"
  | "agent_retry"
  | "execution_plan"
  | "delegated_child";
export type TaskLaunchEngineExtras = Readonly<
  Pick<
    LaunchRunInput,
    | "flowId"
    | "agentId"
    | "agentActivity"
    | "agentPolicyOverlay"
    | "triggerSource"
    | "triggerEventId"
    | "triggerPayload"
    | "agentScheduleId"
    | "agentTriggerReservation"
    | "scheduledFlowRevisionId"
    | "scheduledRequestSnapshot"
    | "scheduledReservation"
    | "packagePin"
    | "allowConcurrent"
    | "evaluationStudyId"
    | "evaluationBatchItemId"
    | "sessionRunnerOverrides"
    | "evaluationFlowRevisionId"
    | "evaluationFormInputs"
    | "librarianOperationId"
    | "parentRunId"
    | "rootRunId"
    | "launchMode"
    | "delegationSnapshot"
  > &
    Pick<
      LaunchAgentRunInput,
      "resultContract" | "persistent" | "addressableKey" | "workspaceMode"
    >
>;
export type TaskLaunchFixedAllocation = Readonly<{
  runId: string;
  taskAttemptNumber: number;
  branch: string;
  worktreePath: string;
}>;
export type TaskLaunchServerSourceSnapshot = Readonly<{
  version: 1;
  kind: TaskLaunchServerSourceKind;
  id: string;
  projectId: string;
  taskId: string;
  revisionDigest: string;
  branchBase?: string;
  agentWorkspace?: "none" | "repo_read" | "worktree";
  execution: TaskLaunchEngineExtras;
  fixedAllocation?: TaskLaunchFixedAllocation;
}>;
export type TaskLaunchServerSourceValidator = (
  db: Db,
  source: TaskLaunchServerSourceSnapshot,
) => Promise<void>;
export type TaskLaunchServerSource = Readonly<{
  [serverSourceAuthority]: true;
  snapshot: TaskLaunchServerSourceSnapshot;
  assertCurrent: TaskLaunchServerSourceValidator;
}>;

/** Source-family constructors load their database-owned scope before minting this private capability. */
export async function createTaskLaunchServerSource(
  db: Db,
  snapshot: TaskLaunchServerSourceSnapshot,
  assertCurrent: TaskLaunchServerSourceValidator,
): Promise<TaskLaunchServerSource> {
  if (
    snapshot.version !== 1 ||
    snapshot.id.length < 1 ||
    snapshot.id.length > 180 ||
    !/^[a-f0-9]{64}$/.test(snapshot.revisionDigest)
  )
    throw launchRefusal("launch_source_snapshot_incomplete", "PRECONDITION");
  await assertCurrent(db, snapshot);

  return { [serverSourceAuthority]: true, snapshot, assertCurrent };
}

export function assertTaskLaunchServerSource(
  source: TaskLaunchServerSource,
): void {
  if (source?.[serverSourceAuthority] !== true)
    throw launchRefusal("launch_source_authority_required", "PRECONDITION");
}

/** Stable source replay precedes fresh optimistic tokens; this internal read never grants admission. */
export async function findServerTaskLaunch(
  db: Db,
  scope: Pick<
    TaskLaunchServerSourceSnapshot,
    "kind" | "id" | "projectId" | "taskId"
  >,
  requestKey: string,
): Promise<TaskLaunchReceipt | null> {
  const [intent] = await db
    .select()
    .from(taskLaunchIntents)
    .where(
      and(
        eq(taskLaunchIntents.principalKind, "system"),
        eq(taskLaunchIntents.principalId, `${scope.kind}:${scope.id}`),
        eq(taskLaunchIntents.projectId, scope.projectId),
        eq(taskLaunchIntents.taskId, scope.taskId),
        eq(
          taskLaunchIntents.operation,
          scope.kind === "ralph_retry" ? "retry" : "launch",
        ),
        eq(taskLaunchIntents.requestKey, requestKey),
      ),
    );

  if (!intent) return null;
  if (
    intent.settingsSnapshot.version !== 2 ||
    !intent.settingsSnapshot.serverExecution
  )
    throw launchRefusal("launch_source_snapshot_incomplete", "PRECONDITION");
  await assertStoredTaskLaunchServerSource(
    db,
    intent.settingsSnapshot.serverExecution,
  );

  return taskLaunchReceipt(intent);
}

/** Restart reconstruction uses static source owners, never a process-local callback registry. */
export async function assertStoredTaskLaunchServerSource(
  db: Db,
  source: TaskLaunchServerSourceSnapshot,
): Promise<void> {
  switch (source.kind) {
    case "scheduled_job":
      return (
        await import("@/lib/scheduler/task-launch-source")
      ).assertStoredScheduledJobLaunchSource(db, source);
    case "run_schedule":
      return (
        await import("@/lib/run-schedules/launch-authority")
      ).assertStoredRunScheduleLaunchSource(db, source);
    case "scheduled_task":
      return (
        await import("@/lib/scheduled-launches/launch-authority")
      ).assertStoredScheduledTaskLaunchSource(db, source);
    case "agent_trigger":
      return (
        await import("@/lib/agents/flow-launch-authority")
      ).assertStoredAgentTriggerLaunchSource(db, source);
    case "delegated_child":
      return (
        await import("@/lib/orchestrator/delegated-launch-authority")
      ).assertStoredDelegatedTaskLaunchSource(db, source);
    case "execution_plan":
      return (
        await import("@/lib/domain-events/plan-launch-authority")
      ).assertStoredPlanFlowTaskLaunchSource(db, source);
    case "evaluation":
      return (
        await import("@/lib/evaluations/launch-authority")
      ).assertStoredEvaluationLaunchSource(db, source);
    case "budget_restart":
      return (
        await import("@/lib/tasks/launch-budget-authority")
      ).assertStoredBudgetRestartLaunchSource(db, source);
    case "ralph_retry":
      return (
        await import("@/lib/runs/ralph-launch-authority")
      ).assertStoredRalphRetryLaunchSource(db, source);
    case "agent_retry":
      return (
        await import("@/lib/agents/task-retry-authority")
      ).assertStoredAgentTaskRetryLaunchSource(db, source);
  }
}
