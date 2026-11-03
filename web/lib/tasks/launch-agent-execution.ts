import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { AgentLaunchRuntime } from "@/lib/agents/launch";
import type { TaskAdmissionSnapshot } from "./qualification-types";
import type {
  TaskLaunchClaim,
  TaskLaunchAgentClaim,
} from "./launch-dispatch-claim";
import type { TaskLaunchSettingsV2Snapshot } from "./launch-types";
import type { Run } from "@/lib/db/schema";
import type { OperationalResourceKind } from "@/lib/run-results/operational-types";

import { and, eq, sql } from "drizzle-orm";

import { taskLaunchAllowsTaskStatus } from "./launch-task-status";
import {
  lockedTaskLaunchClaim,
  assertTaskLaunchAgentClaim,
} from "./launch-dispatch-claim";
import { assertTaskLaunchDispatchAuthority } from "./launch-dispatch-authority";
import { loadTaskSemanticInput } from "./launch-input";
import {
  launchRefusal,
  taskLaunchSelectedConfiguration,
} from "./launch-resolution";
import {
  storedTaskAgentLaunchTrigger,
  assertTaskAgentSharedRootCurrent,
  agentTaskLaunchMetadataToken,
  resolveTaskLaunchAutomaticEvidenceCommit,
} from "./launch-agent-resolution";
import { pinnedTaskAgentDefinition } from "./launch-agent-definition";
import {
  armedAutomaticTaskLaunchBasis,
  automaticTaskLaunchBasis,
} from "./launch-automatic";
import { isManualTriageHold } from "./manual-launch-hold";
import {
  lockTaskLaunchReservation,
  lockTaskLaunchBoundRun,
} from "./launch-locks";
import { emitTaskLaunchChanged } from "./launch-events";
import {
  assertTaskLaunchRelaunchSource,
  captureTaskLaunchRelaunchSource,
} from "./launch-continuation";

import { recordTaskAgentTriggerRunBound } from "@/lib/agents/task-trigger-reservation";
import {
  taskLaunchIntents,
  tasks,
  projects,
  workspaces,
  runs,
} from "@/lib/db/schema";
import { resolveAgentConfig } from "@/lib/agents/config";
import { retryDigest } from "@/lib/agents/retry-guards";
import { countOpenBlockingClarifications } from "@/lib/tasks/clarification-gate";
import { getOpenRelationBlockers } from "@/lib/social/relations";
import {
  assertBaseCommitReachable,
  resolveBaseCommit,
  statusPorcelain,
} from "@/lib/worktree";
import { takeSchedulerLock } from "@/lib/scheduler";
import { runtimeRoot } from "@/lib/runtime-root";
import { verifyOperationalIntegrity } from "@/lib/agents/operational-integrity";
import { findSharedTreeWorkspace } from "@/lib/runs/shared-tree";

const agentExecutionAuthority = Symbol("accepted task agent execution");

type AgentSettings = Extract<TaskLaunchSettingsV2Snapshot, { kind: "agent" }>;
type Intent = typeof taskLaunchIntents.$inferSelect;

export type AcceptedTaskAgentLaunchExecution = Readonly<{
  [agentExecutionAuthority]: true;
  claim: TaskLaunchAgentClaim;
  intent: Intent;
  settings: AgentSettings;
  runtime: AgentLaunchRuntime;
  configuration: Record<string, unknown>;
  admission: Readonly<{
    snapshot: TaskAdmissionSnapshot;
    apply: (tx: Db) => Promise<TaskAdmissionSnapshot>;
  }>;
  assertCurrent: (db: Db) => Promise<void>;
  beginBinding: (tx: Db) => Promise<void>;
  bindRun: (tx: Db) => Promise<void>;
}>;

export function assertAcceptedTaskAgentLaunchExecution(
  execution: AcceptedTaskAgentLaunchExecution,
): void {
  if (execution?.[agentExecutionAuthority] !== true)
    throw launchRefusal("launch_worker_fenced");
}

/** The resource is the actual owned cwd; none uses runtimeRoot only as a non-Git ownership namespace. */
export async function taskAgentPreparationWorkspace(
  db: Db,
  run: Pick<Run, "id" | "taskLaunchIntentId" | "projectId">,
): Promise<{
  cwd: string;
  repoPath: string;
  projectSlug: string;
  resourceKind: OperationalResourceKind;
}> {
  const [intent] = await db
    .select()
    .from(taskLaunchIntents)
    .where(eq(taskLaunchIntents.id, run.taskLaunchIntentId ?? ""));
  const settings = intent?.settingsSnapshot;
  const identity = intent?.preparationIdentity;
  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.id, run.projectId ?? ""));

  if (
    !intent ||
    intent.originalRunId !== run.id ||
    !project ||
    settings?.version !== 2 ||
    settings.kind !== "agent" ||
    !settings.agentSnapshot ||
    identity?.version !== 2
  )
    throw launchRefusal("launch_agent_snapshot_incomplete", "PRECONDITION");
  if (settings.workspace === "none")
    return {
      cwd: identity.worktreePath,
      repoPath: runtimeRoot(),
      projectSlug: project.slug,
      resourceKind: "plain_directory",
    };
  if (settings.workspace === "repo_read")
    return {
      cwd: identity.worktreePath,
      repoPath: identity.parentRepoPath ?? project.repoPath,
      projectSlug: project.slug,
      resourceKind: settings.agentSnapshot.workspaceRef
        ? "ephemeral_checkout"
        : "shared_repository",
    };
  const shared = settings.agentSnapshot.sharedRoot
    ? await findSharedTreeWorkspace(
        db,
        settings.agentSnapshot.sharedRoot.rootRunId,
      )
    : null;
  const [workspace] = await db
    .select()
    .from(workspaces)
    .where(
      shared ? eq(workspaces.id, shared.id) : eq(workspaces.runId, run.id),
    );

  if (
    !workspace ||
    workspace.removedAt ||
    workspace.worktreePath !== identity.worktreePath ||
    (settings.agentSnapshot.sharedRoot &&
      (!shared ||
        workspace.baseCommit !== settings.agentSnapshot.sharedRoot.baseCommit ||
        workspace.branch !== settings.agentSnapshot.sharedRoot.branch))
  )
    throw launchRefusal("launch_workspace_changed", "PRECONDITION");

  return {
    cwd: workspace.worktreePath,
    repoPath: workspace.parentRepoPath,
    projectSlug: project.slug,
    resourceKind: "worktree",
  };
}

/** Current kill switches and config/runner identities are checked without replacing accepted settings. */
export async function assertFrozenTaskAgentCurrent(
  db: Db,
  intent: Intent,
): Promise<void> {
  const settings = intent.settingsSnapshot;

  if (
    settings.version !== 2 ||
    settings.kind !== "agent" ||
    !settings.agentSnapshot ||
    intent.inputSnapshot.version !== 2
  )
    throw launchRefusal("launch_agent_snapshot_incomplete", "PRECONDITION");
  if (settings.relaunchSource) {
    if (intent.sourceRunId !== settings.relaunchSource.runId)
      throw launchRefusal("launch_source_snapshot_incomplete", "PRECONDITION");
    if (intent.reservationLane === "ordinary")
      await captureTaskLaunchRelaunchSource(db, {
        sourceRunId: settings.relaunchSource.runId,
        projectId: intent.projectId,
        taskId: intent.taskId,
      });
    await assertTaskLaunchRelaunchSource(db, settings.relaunchSource);
  } else if (intent.sourceRunId)
    throw launchRefusal("launch_source_snapshot_incomplete", "PRECONDITION");
  await assertTaskLaunchDispatchAuthority(db, intent);
  await assertTaskAgentSharedRootCurrent(db, settings, intent.runId);
  const { task, snapshot } = await loadTaskSemanticInput(
    db,
    intent.projectId,
    intent.taskId,
  );

  if (
    retryDigest({
      ...snapshot,
      target: intent.inputSnapshot.target,
      deliveryTarget: intent.inputSnapshot.deliveryTarget,
    }) !== intent.inputDigest
  )
    throw launchRefusal("launch_input_changed");
  if (
    retryDigest(taskLaunchSelectedConfiguration(task)) !==
    settings.taskSettingsDigest
  )
    throw launchRefusal("launch_settings_changed");
  if (task.queuePaused) throw launchRefusal("queue_paused", "PRECONDITION");
  if (isManualTriageHold(task))
    throw launchRefusal("launch_task_held", "PRECONDITION");
  if (!taskLaunchAllowsTaskStatus(intent, task.status))
    throw launchRefusal("launch_task_terminal", "PRECONDITION");
  if (await countOpenBlockingClarifications(task.id, db))
    throw launchRefusal("clarification_pending", "PRECONDITION");
  if ((await getOpenRelationBlockers([task.id], db)).get(task.id)?.length)
    throw launchRefusal("blocked", "PRECONDITION");
  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.id, intent.projectId));

  if (!project || settings.sessions.length !== 1)
    throw launchRefusal("launch_agent_snapshot_incomplete", "PRECONDITION");
  const acceptedSelection = settings.agentSnapshot.selection;
  const metadataDigest = await agentTaskLaunchMetadataToken(db, task, project, {
    agentId: settings.agentId,
    ...(acceptedSelection.runnerId
      ? { runnerId: acceptedSelection.runnerId }
      : {}),
    ...(acceptedSelection.workspace
      ? { workspace: acceptedSelection.workspace }
      : {}),
    ...(settings.relaunchSource
      ? { relaunchOfRunId: settings.relaunchSource.runId }
      : {}),
  });

  if (metadataDigest !== settings.agentSnapshot.metadataDigest)
    throw launchRefusal("launch_settings_changed");
  if (intent.basis.kind === "automatic") {
    const readBasis =
      settings.serverExecution || intent.basis.origin
        ? automaticTaskLaunchBasis
        : armedAutomaticTaskLaunchBasis;
    const current = await readBasis(
      db,
      task,
      settings,
      intent.basis.evidenceSha,
    );
    const { origin: _origin, ...accepted } = intent.basis;

    if (retryDigest(current) !== retryDigest(accepted))
      throw launchRefusal("qualification_stale", "PRECONDITION");
  }
}

/** Repository-less agents do not acquire a synthetic Git identity. */
export async function assertFrozenTaskAgentRepository(
  db: Db,
  intent: Intent,
): Promise<void> {
  const settings = intent.settingsSnapshot;

  if (
    settings.version !== 2 ||
    settings.kind !== "agent" ||
    !settings.agentSnapshot
  )
    throw launchRefusal("launch_agent_snapshot_incomplete", "PRECONDITION");
  await pinnedTaskAgentDefinition(db, {
    agentId: settings.agentId,
    ...settings.agentSnapshot,
  });
  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.id, intent.projectId));

  if (!project) throw launchRefusal("launch_task_missing", "PRECONDITION");
  const [bound] = intent.runId
    ? await db.select().from(runs).where(eq(runs.id, intent.runId))
    : [];
  const baseline = bound?.operationalIntegrityBaseline;

  if (bound && baseline && !intent.dispatchCommittedAt) {
    const descriptor = await taskAgentPreparationWorkspace(db, bound);

    if (baseline.owner?.cwd !== descriptor.cwd)
      throw launchRefusal("launch_workspace_changed", "PRECONDITION");
    const integrity = await verifyOperationalIntegrity(
      descriptor.cwd,
      baseline,
    );

    if (integrity.verdict !== "clean")
      throw launchRefusal("launch_agent_integrity_refused", "PRECONDITION");
  }
  if (settings.workspace !== "none") {
    if (!settings.baseCommit)
      throw launchRefusal("launch_agent_snapshot_incomplete", "PRECONDITION");
    await assertBaseCommitReachable({
      projectRepoPath: project.repoPath,
      baseRef: settings.baseBranch,
      baseCommit: settings.baseCommit,
      preferRemote: "origin",
    });
    if (
      !baseline &&
      settings.workspace === "repo_read" &&
      !settings.agentSnapshot.workspaceRef &&
      ((await resolveBaseCommit({
        projectRepoPath: project.repoPath,
        baseRef: "HEAD",
      })) !== settings.baseCommit ||
        (await statusPorcelain({ worktreePath: project.repoPath })).trim())
    )
      throw launchRefusal("launch_workspace_changed", "PRECONDITION");
  }
  if (
    intent.basis.kind === "automatic" &&
    (await resolveTaskLaunchAutomaticEvidenceCommit(
      db,
      project,
      intent.taskId,
    )) !== intent.basis.evidenceSha
  )
    throw launchRefusal("qualification_evidence_stale", "PRECONDITION");
}

/** Only a durable current claim can construct the private allocator context. */
export async function acceptedTaskAgentLaunchExecution(
  db: Db,
  claim: TaskLaunchClaim,
): Promise<AcceptedTaskAgentLaunchExecution> {
  assertTaskLaunchAgentClaim(claim);
  const intent = await lockedTaskLaunchClaim(db, claim);

  await assertFrozenTaskAgentCurrent(db, intent);
  await assertFrozenTaskAgentRepository(db, intent);
  const settings = intent.settingsSnapshot;

  if (
    settings.version !== 2 ||
    settings.kind !== "agent" ||
    !settings.agentSnapshot
  )
    throw launchRefusal("launch_agent_snapshot_incomplete", "PRECONDITION");
  const { resolveAgentLaunchRuntime } = await import("@/lib/agents/launch");
  const currentRuntime = await resolveAgentLaunchRuntime({
    agentId: settings.agentId,
    projectId: intent.projectId,
    taskId: intent.taskId,
    workspace: settings.workspace,
    launchOverrideRunnerId: settings.sessions[0]?.runnerId,
    trigger: settings.serverExecution
      ? storedTaskAgentLaunchTrigger(settings.serverExecution)
      : { source: "manual" },
    db,
  });
  const resolutionTier = settings.sessions[0]?.runnerResolutionTier;

  if (!resolutionTier)
    throw launchRefusal("launch_agent_snapshot_incomplete", "PRECONDITION");
  const runtime: AgentLaunchRuntime = {
    ...currentRuntime,
    resolution: {
      ...currentRuntime.resolution,
      runnerResolutionTier: resolutionTier,
    },
    effective: await pinnedTaskAgentDefinition(db, {
      agentId: settings.agentId,
      ...settings.agentSnapshot,
    }),
    project: { ...currentRuntime.project, ...settings.agentSnapshot.project },
    link: {
      ...currentRuntime.link,
      branchBase: settings.agentSnapshot.branchBase,
    },
  };
  const configuration = resolveAgentConfig(
    runtime.effective.parsed.config,
    runtime.link.config ?? null,
  );

  if (
    retryDigest(configuration) !== settings.agentSnapshot.configurationDigest ||
    retryDigest(runtime.resolution.runnerSnapshot) !==
      settings.sessions[0].runnerConfigDigest
  )
    throw launchRefusal("launch_settings_changed");
  const basis = intent.basis;
  const snapshot: TaskAdmissionSnapshot = {
    version: 2,
    policyVersion: 2,
    mode:
      basis.kind === "manual"
        ? "manual"
        : basis.kind === "automatic"
          ? "required"
          : "execution_child",
    intentId: intent.id,
    basis: basis.kind,
    inputRevision: intent.inputRevision,
    qualificationId: basis.kind === "automatic" ? basis.qualificationId : null,
    qualificationRevision:
      basis.kind === "automatic" ? basis.qualificationRevision : null,
    evidenceTarget:
      basis.kind === "automatic" ? basis.evidenceTarget : settings.baseBranch,
    evidenceSha:
      basis.kind === "automatic" ? basis.evidenceSha : settings.baseCommit,
    parent: basis.kind === "execution_child" ? basis.parent : null,
  };
  const assertCurrent = async (connection: Db): Promise<void> => {
    await assertFrozenTaskAgentCurrent(
      connection,
      await lockedTaskLaunchClaim(connection, claim),
    );
  };

  return {
    [agentExecutionAuthority]: true,
    claim,
    intent,
    settings,
    runtime,
    configuration,
    admission: {
      snapshot,
      apply: async (tx) => {
        await assertCurrent(tx);

        return snapshot;
      },
    },
    assertCurrent,
    beginBinding: async (tx) => {
      await takeSchedulerLock(tx);
      await lockTaskLaunchReservation(tx, intent.taskId);
      await lockTaskLaunchBoundRun(tx, intent.id);
      await lockedTaskLaunchClaim(tx, claim);
      await tx
        .select({ id: tasks.id })
        .from(tasks)
        .where(eq(tasks.id, intent.taskId))
        .for("update");
      await assertCurrent(tx);
    },
    bindRun: async (tx) => {
      const current = await lockedTaskLaunchClaim(tx, claim);
      const [bound] = await tx
        .update(taskLaunchIntents)
        .set({
          state: "run_bound",
          stateVersion: current.stateVersion + 1,
          runId: claim.identity.runId,
          originalRunId: claim.identity.runId,
          preparationPhase: "run_bound",
          leaseToken: null,
          leaseExpiresAt: null,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(
          and(
            eq(taskLaunchIntents.id, current.id),
            eq(taskLaunchIntents.state, "preparing"),
          ),
        )
        .returning();

      if (!bound) throw launchRefusal("launch_worker_fenced");
      await recordTaskAgentTriggerRunBound(tx, bound, claim.identity.runId);
      await emitTaskLaunchChanged(tx, bound, { type: "system", id: null });
    },
  };
}
