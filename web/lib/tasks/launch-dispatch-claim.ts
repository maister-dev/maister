import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type {
  TaskLaunchPreparationIdentity,
  TaskLaunchFlowPreparationIdentity,
  TaskLaunchAgentPreparationIdentity,
  TaskLaunchPreparationPhase,
} from "./launch-types";

import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

import { and, eq, isNull, sql } from "drizzle-orm";

import { assertTaskAgentSharedRootCurrent } from "./launch-agent-resolution";
import { lockTaskLaunchExecutionParent } from "./launch-parent-admission";
import { isAutomaticTaskLaunchDrain } from "./launch-capacity";
import { assertTaskLaunchDispatchAuthority } from "./launch-dispatch-authority";
import {
  lockTaskLaunchReservation,
  lockTaskLaunchBoundRun,
} from "./launch-locks";
import { emitTaskLaunchChanged } from "./launch-events";
import { launchRefusal } from "./launch-resolution";
import { isManualTriageHold } from "./manual-launch-hold";

import { isMaisterError } from "@/lib/errors";
import { admitDelegatedChild } from "@/lib/orchestrator/admission";
import {
  projects,
  tasks,
  taskLaunchIntents,
  runs,
  workspaces,
} from "@/lib/db/schema";
import {
  agentWorkdirPath,
  sharedAgentWorktreePath,
  agentReadOnlyWorkdirPath,
} from "@/lib/agents/workspace-paths";
import { agentWorktreeBranchName } from "@/lib/agents/launch";
import { findSharedTreeWorkspace } from "@/lib/runs/shared-tree";
import { runtimeRoot } from "@/lib/runtime-root";
import { worktreesRoot } from "@/lib/instance-config";
import {
  countLiveRuns,
  effectivePoolCap,
  takeSchedulerLock,
} from "@/lib/scheduler";
import {
  countLiveAutoFlowRuns,
  countOutstandingC2Claims,
} from "@/lib/scheduler/c2-eligibility";
import {
  resolveAutoReserve,
  resolveMaxInFlightAuto,
} from "@/lib/tasks/queue-settings";
import { upgradeMaintenanceEngaged } from "@/lib/maintenance/upgrade-fence";

const claimAuthority = Symbol("claimed task launch");
const LEASE_SECONDS = 60;

export type TaskLaunchClaim = Readonly<{
  [claimAuthority]: true;
  intentId: string;
  taskId: string;
  projectId: string;
  leaseToken: string;
  identity: TaskLaunchPreparationIdentity;
}>;

export type TaskLaunchFlowClaim = Omit<TaskLaunchClaim, "identity"> &
  Readonly<{ identity: TaskLaunchFlowPreparationIdentity }>;
export type TaskLaunchAgentClaim = Omit<TaskLaunchClaim, "identity"> &
  Readonly<{ identity: TaskLaunchAgentPreparationIdentity }>;
export function assertTaskLaunchFlowClaim(
  claim: TaskLaunchClaim,
): asserts claim is TaskLaunchFlowClaim {
  assertClaim(claim);
  if (claim.identity.version !== 1)
    throw launchRefusal("launch_target_unsupported", "PRECONDITION");
}
export function assertTaskLaunchAgentClaim(
  claim: TaskLaunchClaim,
): asserts claim is TaskLaunchAgentClaim {
  assertClaim(claim);
  if (claim.identity.version !== 2 || claim.identity.kind !== "agent")
    throw launchRefusal("launch_target_unsupported", "PRECONDITION");
}

function assertClaim(claim: TaskLaunchClaim): void {
  if (claim?.[claimAuthority] !== true)
    throw launchRefusal("launch_worker_fenced");
}

/** Pure SQL ownership check; callers keep filesystem and Git effects outside this transaction. */
export async function lockedTaskLaunchClaim(
  db: Db,
  claim: TaskLaunchClaim,
): Promise<typeof taskLaunchIntents.$inferSelect> {
  assertClaim(claim);
  const [intent] = await db
    .select()
    .from(taskLaunchIntents)
    .where(
      and(
        eq(taskLaunchIntents.id, claim.intentId),
        eq(taskLaunchIntents.state, "preparing"),
        eq(taskLaunchIntents.leaseToken, claim.leaseToken),
        sql`${taskLaunchIntents.leaseExpiresAt}>clock_timestamp()`,
        isNull(taskLaunchIntents.dispatchCommittedAt),
      ),
    )
    .for("update");

  if (
    !intent ||
    intent.taskId !== claim.taskId ||
    intent.projectId !== claim.projectId ||
    intent.preparationIdentity?.incarnationId !== claim.identity.incarnationId
  )
    throw launchRefusal("launch_worker_fenced");

  return intent;
}

export async function claimTaskLaunchIntent(
  db: Db,
  intentId: string,
): Promise<TaskLaunchClaim | null> {
  const [initial] = await db
    .select()
    .from(taskLaunchIntents)
    .where(eq(taskLaunchIntents.id, intentId));

  if (!initial || !["queued", "preparing"].includes(initial.state)) return null;
  await assertTaskLaunchDispatchAuthority(db, initial);
  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.id, initial.projectId));

  if (!project) throw launchRefusal("launch_task_missing", "PRECONDITION");
  const parentRepoPath = path.resolve(project.repoPath);

  return db.transaction(async (tx) => {
    await takeSchedulerLock(tx);
    await lockTaskLaunchExecutionParent(tx, initial);
    await lockTaskLaunchReservation(tx, initial.taskId);
    await lockTaskLaunchBoundRun(tx, initial.id);
    const [intent] = await tx
      .select()
      .from(taskLaunchIntents)
      .where(eq(taskLaunchIntents.id, intentId))
      .for("update");
    const [task] = await tx
      .select()
      .from(tasks)
      .where(eq(tasks.id, initial.taskId))
      .for("update");

    if (
      !intent ||
      !task ||
      intent.dispatchCommittedAt ||
      !["queued", "preparing"].includes(intent.state)
    )
      return null;
    if (intent.runId) {
      const [bound] = await tx
        .select()
        .from(runs)
        .where(eq(runs.id, intent.runId));

      if (
        !bound ||
        bound.status !== "Pending" ||
        intent.preparationPhase !== "run_bound" ||
        intent.preparationIdentity?.runId !== bound.id ||
        bound.taskLaunchIntentId !== intent.id
      )
        throw launchRefusal("launch_input_snapshot_incomplete", "PRECONDITION");
    }
    const due = await tx.execute<{
      eligible: boolean;
    }>(sql`SELECT (${intent.state}='queued' AND ${intent.dueAt}::timestamptz<=clock_timestamp()
      OR ${intent.state}='preparing' AND ${intent.leaseExpiresAt}::timestamptz<=clock_timestamp()) eligible`);

    if (!due.rows[0]?.eligible) return null;
    await assertTaskLaunchDispatchAuthority(tx, intent);
    if (task.queuePaused) throw launchRefusal("queue_paused", "PRECONDITION");
    if (isManualTriageHold(task))
      throw launchRefusal("launch_task_held", "PRECONDITION");
    const settings = intent.settingsSnapshot;

    if (settings.workspace !== "none" && !settings.baseCommit)
      throw launchRefusal("launch_target_unsupported", "PRECONDITION");
    const parentRunId =
      settings.version === 2
        ? settings.serverExecution?.execution.parentRunId
        : null;

    if (parentRunId && !intent.runId) {
      try {
        await admitDelegatedChild(tx, {
          parentRunId,
          launchIntentId: intent.id,
        });
      } catch (error) {
        if (
          !isMaisterError(error) ||
          error.details?.reason !== "delegation_fanout_exhausted"
        )
          throw error;
        const [waiting] = await tx
          .update(taskLaunchIntents)
          .set({
            state: "queued",
            stateVersion: intent.stateVersion + 1,
            reason: "launch_parent_capacity_wait",
            dueAt: sql`clock_timestamp()+interval '1 second'`,
            leaseToken: null,
            leaseExpiresAt: null,
            updatedAt: sql`clock_timestamp()`,
          })
          .where(eq(taskLaunchIntents.id, intent.id))
          .returning();

        await emitTaskLaunchChanged(tx, waiting, { type: "system", id: null });

        return null;
      }
    }
    const pool = settings.kind;
    const effective = await effectivePoolCap(tx, pool);
    const live =
      (await countLiveRuns(tx, pool)) +
      (pool === "flow" ? await countOutstandingC2Claims(tx) : 0);
    const existingReservation =
      intent.state === "preparing" && intent.preparationIdentity !== null
        ? 1
        : 0;
    const automatic = isAutomaticTaskLaunchDrain(intent);
    const cap = upgradeMaintenanceEngaged() ? 0 : effective.cap;
    const available =
      live - existingReservation < cap &&
      (!automatic ||
        (live - existingReservation < cap - resolveAutoReserve() &&
          (await countLiveAutoFlowRuns(tx, intent.projectId)) -
            existingReservation <
            resolveMaxInFlightAuto(project)));

    if (!available) {
      if (existingReservation) {
        const [queued] = await tx
          .update(taskLaunchIntents)
          .set({
            state: "queued",
            stateVersion: intent.stateVersion + 1,
            reason: "launch_capacity_wait",
            dueAt: sql`clock_timestamp()`,
            leaseToken: null,
            leaseExpiresAt: null,
            updatedAt: sql`clock_timestamp()`,
          })
          .where(eq(taskLaunchIntents.id, intent.id))
          .returning();

        await emitTaskLaunchChanged(tx, queued, { type: "system", id: null });
      }

      return null;
    }
    let identity = intent.preparationIdentity;

    if (!identity) {
      const fixed =
        settings.version === 2
          ? settings.serverExecution?.fixedAllocation
          : undefined;
      const allocated = fixed
        ? null
        : await tx
            .update(tasks)
            .set({ attemptNumber: sql`${tasks.attemptNumber}+1` })
            .where(eq(tasks.id, task.id))
            .returning({ n: tasks.attemptNumber });
      const attemptNumber = fixed?.taskAttemptNumber ?? allocated?.[0]?.n;

      if (
        !attemptNumber ||
        (fixed &&
          (fixed.taskAttemptNumber > task.attemptNumber ||
            fixed.worktreePath !==
              path.join(worktreesRoot(), project.slug, fixed.runId)))
      )
        throw launchRefusal(
          "launch_source_snapshot_incomplete",
          "PRECONDITION",
        );
      const triggerReservation =
        settings.version === 2
          ? settings.serverExecution?.execution.agentTriggerReservation
          : undefined;

      if (
        triggerReservation &&
        (settings.version !== 2 ||
          settings.serverExecution?.kind !== "agent_trigger" ||
          (fixed && fixed.runId !== triggerReservation.runId))
      )
        throw launchRefusal(
          "launch_source_snapshot_incomplete",
          "PRECONDITION",
        );
      const runId = fixed?.runId ?? triggerReservation?.runId ?? randomUUID();
      const worktreePath =
        fixed?.worktreePath ?? path.join(worktreesRoot(), project.slug, runId);

      const common = {
        runId,
        taskAttemptNumber: attemptNumber,
        incarnationId: randomUUID(),
        inputDigest: intent.inputDigest,
        settingsDigest: intent.settingsDigest,
      };

      if (settings.kind === "agent") {
        if (settings.version !== 2 || !settings.agentSnapshot)
          throw launchRefusal(
            "launch_agent_snapshot_incomplete",
            "PRECONDITION",
          );
        const runtimePath = agentWorkdirPath(project.slug, runId);
        const sharedRootRunId =
          settings.workspace === "worktree" &&
          settings.serverExecution?.execution.workspaceMode === "shared"
            ? settings.serverExecution.execution.rootRunId
            : null;

        if (
          settings.serverExecution?.execution.workspaceMode === "shared" &&
          settings.workspace === "worktree" &&
          (!sharedRootRunId || !/^[A-Za-z0-9_-]{1,256}$/.test(sharedRootRunId))
        )
          throw launchRefusal(
            "launch_source_snapshot_incomplete",
            "PRECONDITION",
          );
        if (sharedRootRunId) {
          if (settings.agentSnapshot.sharedRoot?.rootRunId !== sharedRootRunId)
            throw launchRefusal(
              "launch_agent_snapshot_incomplete",
              "PRECONDITION",
            );
          await assertTaskAgentSharedRootCurrent(tx, settings, intent.runId);
        }
        const sharedPath = sharedRootRunId
          ? sharedAgentWorktreePath(project.slug, sharedRootRunId)
          : null;
        const sharedOwner = sharedRootRunId
          ? await findSharedTreeWorkspace(tx, sharedRootRunId)
          : null;
        const [sharedWorkspace] = sharedOwner
          ? await tx
              .select()
              .from(workspaces)
              .where(eq(workspaces.id, sharedOwner.id))
          : [];

        if (
          sharedOwner &&
          (!sharedWorkspace ||
            sharedWorkspace.removedAt ||
            sharedWorkspace.worktreePath !== sharedPath)
        )
          throw launchRefusal("launch_workspace_changed", "PRECONDITION");
        const resourcePath =
          settings.workspace === "repo_read"
            ? settings.agentSnapshot.workspaceRef
              ? agentReadOnlyWorkdirPath(project.slug, runId)
              : parentRepoPath
            : (sharedPath ?? runtimePath);
        const repoScope =
          settings.workspace === "none" ? runtimeRoot() : parentRepoPath;

        identity = {
          ...common,
          version: 2,
          kind: "agent",
          workspace: settings.workspace,
          parentRepoPath: settings.workspace === "none" ? null : parentRepoPath,
          worktreePath: resourcePath,
          runtimePath,
          branch:
            settings.workspace === "worktree"
              ? sharedRootRunId
                ? settings.agentSnapshot.sharedRoot!.branch
                : agentWorktreeBranchName({
                    prefix:
                      settings.agentSnapshot.project.branchPrefix ?? "maister/",
                    agentId: settings.agentId,
                    runId,
                  })
              : null,
          baseCommit: settings.baseCommit,
          resourceId: createHash("sha256")
            .update(`${repoScope}\0${resourcePath}`)
            .digest("hex"),
        };
      } else {
        identity = {
          ...common,
          version: 1,
          branch:
            fixed?.branch ??
            `${project.branchPrefix}task-${task.id}/attempt-${attemptNumber}`,
          parentRepoPath,
          worktreePath,
          resourceId: createHash("sha256")
            .update(`${parentRepoPath}\0${worktreePath}`)
            .digest("hex"),
          baseCommit: settings.baseCommit,
        };
      }
    }
    const leaseToken = randomUUID();
    const [claimed] = await tx
      .update(taskLaunchIntents)
      .set({
        state: "preparing",
        stateVersion:
          intent.state === "queued"
            ? intent.stateVersion + 1
            : intent.stateVersion,
        preparationIdentity: identity,
        preparationPhase: intent.preparationPhase ?? "reserved",
        leaseToken,
        reason: null,
        leaseExpiresAt: sql`clock_timestamp()+make_interval(secs=>${LEASE_SECONDS})`,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(eq(taskLaunchIntents.id, intent.id))
      .returning();

    if (intent.state !== "preparing")
      await emitTaskLaunchChanged(tx, claimed, { type: "system", id: null });

    return {
      [claimAuthority]: true,
      intentId,
      taskId: task.id,
      projectId: project.id,
      leaseToken,
      identity,
    } satisfies TaskLaunchClaim;
  });
}

export async function renewTaskLaunchClaim(
  db: Db,
  claim: TaskLaunchClaim,
): Promise<void> {
  await db.transaction(async (tx) => {
    await lockedTaskLaunchClaim(tx, claim);
    await tx
      .update(taskLaunchIntents)
      .set({
        leaseExpiresAt: sql`clock_timestamp()+make_interval(secs=>${LEASE_SECONDS})`,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(eq(taskLaunchIntents.id, claim.intentId));
  });
}

export async function advanceTaskLaunchPreparation(
  db: Db,
  claim: TaskLaunchClaim,
  phase: TaskLaunchPreparationPhase,
): Promise<void> {
  await db.transaction(async (tx) => {
    await lockedTaskLaunchClaim(tx, claim);
    await tx
      .update(taskLaunchIntents)
      .set({ preparationPhase: phase, updatedAt: sql`clock_timestamp()` })
      .where(eq(taskLaunchIntents.id, claim.intentId));
  });
}
