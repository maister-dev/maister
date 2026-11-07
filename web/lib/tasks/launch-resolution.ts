import "server-only";

import type { TaskLaunchServerSourceSnapshot } from "./launch-server-source";
import type { Db } from "@/lib/execution-host/db";
import type { TaskLaunchRequest } from "./launch-schema";
import type { TaskLaunchSettingsV2Snapshot } from "./launch-types";
import type { ResolvedAgentLaunchSettings } from "./launch-agent-resolution";
import type { TaskLaunchFlowAssetsSnapshot } from "./launch-flow-assets";

import { and, eq } from "drizzle-orm";

import { captureConcurrentTaskLaunchRelaunchSource } from "./launch-continuation";
import { resolveTaskLaunchCapabilities } from "./launch-capabilities";
import { selectedTaskLaunchRevision } from "./launch-package-selection";
import { captureTaskLaunchFlowAssets } from "./launch-flow-assets";
import {
  agentTaskLaunchSettingsToken,
  resolveAgentTaskLaunchSettings,
} from "./launch-agent-resolution";

import {
  flows,
  flowRevisions,
  projectFlowRunnerDefaults,
  projects,
  tasks,
  platformRuntimeSettings,
} from "@/lib/db/schema";
import {
  loadFlowRunnerBindings,
  loadRunnerCatalog,
} from "@/lib/acp-runners/catalog";
import { inspectFlowRunners } from "@/lib/acp-runners/flow-preflight";
import { assertFlowStaticEnforcement } from "@/lib/acp-runners/enforcement-preflight";
import { runnerAdmissionError } from "@/lib/flows/runner-admission-error";
import { parseExecutableStoredFlowManifest } from "@/lib/flows/manifest-parser";
import { resolveFlowRef } from "@/lib/flows/resolve-flow-ref";
import { assertFlowLaunchable } from "@/lib/flows/launchability-gate";
import {
  resolveDeliveryPolicy,
  legacyPromotionModeFromStrategy,
  strategyFromLegacyPromotionMode,
} from "@/lib/runs/delivery-policy";
import {
  resolveExecutionPolicy,
  assertNoBlindShip,
} from "@/lib/runs/execution-policy";
import { resolvePinnedFlowRevisionForRefId } from "@/lib/packages/pin";
import { resolveAgentExecutionPolicy } from "@/lib/agents/execution-policy";
import { applyDefaultBudgetForUnattended } from "@/lib/runs/budget-default";
import { retryDigest } from "@/lib/agents/retry-guards";
import { MaisterError } from "@/lib/errors";

export function launchRefusal(
  reason: string,
  code: "CONFLICT" | "PRECONDITION" | "CONFIG" = "CONFLICT",
): MaisterError {
  return new MaisterError(code, "Task launch requires a new decision", {
    details: { reason },
  });
}

/** Reuse the project's UUID/ref contract, including its documented deterministic UUID precedence. */
export async function resolveTaskLaunchFlow(
  db: Db,
  projectId: string,
  selector: string,
): Promise<typeof flows.$inferSelect> {
  const resolved = await resolveFlowRef(projectId, selector, db);

  if (!resolved.ok) throw launchRefusal("flow_unavailable", "PRECONDITION");
  const [flow] = await db
    .select()
    .from(flows)
    .where(and(eq(flows.id, resolved.flowId), eq(flows.projectId, projectId)));

  if (!flow) throw launchRefusal("flow_unavailable", "PRECONDITION");

  return flow;
}

export function taskLaunchConfiguration(
  task: typeof tasks.$inferSelect,
  project: typeof projects.$inferSelect,
): object {
  return {
    version: 1,
    task: {
      flowId: task.flowId,
      runnerId: task.runnerId,
      baseBranch: task.baseBranch,
      targetBranch: task.targetBranch,
      promotionMode: task.promotionMode,
      executionPolicy: task.executionPolicy,
    },
    project: {
      mainBranch: project.mainBranch,
      defaultRunnerId: project.defaultRunnerId,
      promotionMode: project.promotionMode,
      deliveryPolicy: project.deliveryPolicyDefault,
      executionPolicy: project.executionPolicyDefault,
    },
  };
}

/** Saved task choices, independently of mutable project defaults used at acceptance. */
export function taskLaunchSelectedConfiguration(
  task: typeof tasks.$inferSelect,
): object {
  return {
    version: 1,
    flowId: task.flowId,
    runnerId: task.runnerId,
    baseBranch: task.baseBranch,
    targetBranch: task.targetBranch,
    promotionMode: task.promotionMode,
    executionPolicy: task.executionPolicy,
  };
}

/** Read-only config fence, including the current immutable Flow and runner identities. */
export async function taskLaunchSettingsMetadataToken(
  db: Db,
  taskId: string,
  selection: Partial<TaskLaunchRequest> = {},
): Promise<string> {
  const [row] = await db
    .select({ task: tasks, project: projects })
    .from(tasks)
    .innerJoin(projects, eq(projects.id, tasks.projectId))
    .where(eq(tasks.id, taskId));

  if (!row) throw launchRefusal("launch_task_missing", "PRECONDITION");
  if (selection.agentId)
    return agentTaskLaunchSettingsToken(db, row.task, row.project, selection);
  const selectedFlowId = selection.flowId ?? row.task.flowId;
  const flow = selectedFlowId
    ? await resolveTaskLaunchFlow(db, row.project.id, selectedFlowId)
    : null;
  const selected = flow
    ? await selectedTaskLaunchRevision(db, row.project.id, flow, selection)
    : null;
  const revision = selected?.revision;
  const catalog = await loadRunnerCatalog(db);
  const [runtime] = await db
    .select()
    .from(platformRuntimeSettings)
    .where(eq(platformRuntimeSettings.id, "singleton"));
  const bindings = revision
    ? await loadFlowRunnerBindings(db, row.project.id, revision.id)
    : [];
  const [defaults] = flow
    ? await db
        .select()
        .from(projectFlowRunnerDefaults)
        .where(
          and(
            eq(projectFlowRunnerDefaults.projectId, row.project.id),
            eq(projectFlowRunnerDefaults.flowId, flow.id),
          ),
        )
    : [];
  const capabilities = revision
    ? await resolveTaskLaunchCapabilities(db, {
        projectId: row.project.id,
        flowRevisionId: revision.id,
        flowSource: revision.source,
      })
    : null;

  return retryDigest({
    configuration: taskLaunchConfiguration(row.task, row.project),
    relaunchSource: selection.relaunchOfRunId
      ? await captureConcurrentTaskLaunchRelaunchSource(db, {
          sourceRunId: selection.relaunchOfRunId,
          projectId: row.project.id,
          taskId: row.task.id,
        })
      : null,
    flow: flow
      ? {
          id: flow.id,
          revision: revision?.id ?? null,
          manifestDigest: revision ? retryDigest(revision.manifest) : null,
          state: flow.enablementState,
          packageInstallId: selected?.packageInstallId ?? null,
        }
      : null,
    revisionRunner: revision?.defaultRunnerId ?? null,
    capabilityResolutionDigest:
      capabilities?.capabilityResolutionDigest ?? null,
    runtimeRunner: runtime?.defaultRunnerId ?? null,
    flowRunner: defaults?.runnerId ?? null,
    bindings: [...bindings].sort((a, b) => a.slotKey.localeCompare(b.slotKey)),
    runners: catalog
      .map((runner) => ({ id: runner.id, digest: retryDigest(runner) }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  });
}

export function composeTaskLaunchSettingsToken(
  metadataToken: string,
  flowAssets: TaskLaunchFlowAssetsSnapshot | null,
): string {
  return retryDigest({ version: 1, metadataToken, flowAssets });
}

/** Preview includes the actual directory identity; filesystem access stays outside the acceptance transaction. */
export async function taskLaunchSettingsToken(
  db: Db,
  taskId: string,
  selection: Partial<TaskLaunchRequest> = {},
): Promise<string> {
  const metadataToken = await taskLaunchSettingsMetadataToken(
    db,
    taskId,
    selection,
  );

  if (selection.agentId) return metadataToken;
  const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId));

  if (!task) throw launchRefusal("launch_task_missing", "PRECONDITION");
  const selector = selection.flowId ?? task.flowId;
  const flow = selector
    ? await resolveTaskLaunchFlow(db, task.projectId, selector)
    : null;
  const selected = flow
    ? await selectedTaskLaunchRevision(db, task.projectId, flow, selection)
    : null;
  const assets = selected?.revision
    ? await captureTaskLaunchFlowAssets(db, {
        flowRevisionId: selected.revision.id,
      })
    : null;

  return composeTaskLaunchSettingsToken(metadataToken, assets);
}

export type ResolvedFlowLaunchSettings = Omit<
  Extract<TaskLaunchSettingsV2Snapshot, { kind: "flow" }>,
  "baseCommit"
>;

export type ResolvedTaskLaunchSettings =
  ResolvedFlowLaunchSettings | ResolvedAgentLaunchSettings;

/** Target selection changes admission settings without inventing a Flow for a standalone agent. */
export async function resolveTaskLaunchSettings(
  db: Db,
  task: typeof tasks.$inferSelect,
  project: typeof projects.$inferSelect,
  selection: Partial<TaskLaunchRequest>,
): Promise<ResolvedTaskLaunchSettings> {
  return selection.agentId
    ? resolveAgentTaskLaunchSettings(db, task, project, selection)
    : resolveFlowLaunchSettings(db, task, project, selection);
}

/** Resolve through the existing Flow runner/policy authorities; never materialize or launch. */
export async function resolveFlowLaunchSettings(
  db: Db,
  task: typeof tasks.$inferSelect,
  project: typeof projects.$inferSelect,
  selection: Partial<TaskLaunchRequest>,
): Promise<ResolvedFlowLaunchSettings> {
  return resolveFlowLaunchSettingsForSource(db, task, project, selection, null);
}

/** A database-owned source may pin a controlled target; no transport accepts these extras. */
export async function resolveServerFlowLaunchSettings(
  db: Db,
  task: typeof tasks.$inferSelect,
  project: typeof projects.$inferSelect,
  selection: Partial<TaskLaunchRequest>,
  source: TaskLaunchServerSourceSnapshot,
): Promise<ResolvedFlowLaunchSettings> {
  return resolveFlowLaunchSettingsForSource(
    db,
    task,
    project,
    selection,
    source,
  );
}

async function resolveFlowLaunchSettingsForSource(
  db: Db,
  task: typeof tasks.$inferSelect,
  project: typeof projects.$inferSelect,
  selection: Partial<TaskLaunchRequest>,
  source: TaskLaunchServerSourceSnapshot | null,
): Promise<ResolvedFlowLaunchSettings> {
  const flowId = selection.flowId ?? task.flowId;

  if (!flowId) throw launchRefusal("unconfigured", "PRECONDITION");
  const flow = await resolveTaskLaunchFlow(db, project.id, flowId);
  const selected = await selectedTaskLaunchRevision(
    db,
    project.id,
    flow,
    selection,
  );

  const execution = source?.execution;
  const pinned = execution?.packagePin
    ? await resolvePinnedFlowRevisionForRefId(db, {
        flowRefId: flow.flowRefId,
        packageInstallId: execution.packagePin.packageInstallId,
      })
    : null;
  const pinnedRevisionId =
    execution?.evaluationFlowRevisionId ??
    execution?.scheduledFlowRevisionId ??
    pinned?.id;
  const [controlledRevision] = pinnedRevisionId
    ? await db
        .select()
        .from(flowRevisions)
        .where(eq(flowRevisions.id, pinnedRevisionId))
    : [];
  const candidateRevision = pinnedRevisionId
    ? controlledRevision
    : selected.revision;
  // Acceptance keeps this row stable through its intent INSERT; an updater then sees the durable reference.
  const [revision] = candidateRevision
    ? await db
        .select()
        .from(flowRevisions)
        .where(eq(flowRevisions.id, candidateRevision.id))
        .for("share")
    : [];
  const packageInstallId =
    execution?.packagePin?.packageInstallId ?? selected.packageInstallId;

  if (revision && revision.flowRefId !== flow.flowRefId)
    throw launchRefusal("flow_unavailable", "PRECONDITION");
  assertFlowLaunchable(flow.flowRefId, flow, revision ?? null);
  if (!revision) throw launchRefusal("flow_unavailable", "PRECONDITION");
  const manifest = parseExecutableStoredFlowManifest(revision.manifest, {
    code: "CONFIG",
    surface: "launch-service",
    manifestLabel: `flow revision ${revision.id}`,
    flowRefId: flow.flowRefId,
    revision: revision.resolvedRevision,
  });
  const [runtime] = await db
    .select()
    .from(platformRuntimeSettings)
    .where(eq(platformRuntimeSettings.id, "singleton"));

  if (!runtime?.defaultRunnerId)
    throw new MaisterError(
      "EXECUTOR_UNAVAILABLE",
      "No platform runner is configured",
    );
  const [defaults] = await db
    .select()
    .from(projectFlowRunnerDefaults)
    .where(
      and(
        eq(projectFlowRunnerDefaults.projectId, project.id),
        eq(projectFlowRunnerDefaults.flowId, flow.id),
      ),
    );
  const inspection = inspectFlowRunners({
    manifest,
    bindings: await loadFlowRunnerBindings(db, project.id, revision.id),
    taskRunnerId: task.runnerId,
    sessionRunnerOverrides: execution?.sessionRunnerOverrides,
    launchOverrideRunnerId: selection.runnerId,
    projectFlow: { defaultRunnerId: defaults?.runnerId ?? null },
    platformFlow: { defaultRunnerId: revision.defaultRunnerId },
    project: { defaultRunnerId: project.defaultRunnerId },
    platform: { defaultRunnerId: runtime.defaultRunnerId },
    runners: await loadRunnerCatalog(db),
  });
  const sessions = inspection.sessions.map((session) => {
    if (session.status === "unresolved")
      throw runnerAdmissionError({
        taskId: task.id,
        projectId: project.id,
        slotKey: session.slotKey,
        label: session.label,
        error: session.error,
      });
    const {
      env: _environment,
      provider: _provider,
      ...identity
    } = session.resolution.runnerSnapshot;

    return {
      sessionName: session.sessionName,
      runnerId: session.resolution.runnerId,
      runnerSnapshot: identity,
      runnerConfigDigest: retryDigest(session.resolution.runnerSnapshot),
      runnerResolutionTier: session.resolution.runnerResolutionTier,
    };
  });
  const consensus = inspection.consensus.map((slot) => {
    if (slot.status === "unresolved")
      throw runnerAdmissionError({
        taskId: task.id,
        projectId: project.id,
        slotKey: slot.slotKey,
        label: slot.label,
        error: slot.error,
      });
    const {
      env: _environment,
      provider: _provider,
      ...identity
    } = slot.resolution.runnerSnapshot;

    return {
      sessionName: slot.slotKey,
      runnerId: slot.resolution.runnerId,
      runnerSnapshot: identity,
      runnerConfigDigest: retryDigest(slot.resolution.runnerSnapshot),
      runnerResolutionTier: slot.resolution.runnerResolutionTier,
    };
  });

  assertFlowStaticEnforcement(manifest, inspection);
  const baseBranch =
    selection.baseBranch ?? task.baseBranch ?? project.mainBranch;
  const targetBranch =
    selection.targetBranch ??
    selection.deliveryPolicy?.targetBranch ??
    task.targetBranch ??
    baseBranch;
  const deliveryPolicy = resolveDeliveryPolicy({
    projectDefault: project.deliveryPolicyDefault,
    projectPromotionMode: project.promotionMode,
    projectMainBranch: project.mainBranch,
    launchOverride: {
      ...(task.promotionMode
        ? { strategy: strategyFromLegacyPromotionMode(task.promotionMode) }
        : {}),
      ...selection.deliveryPolicy,
      targetBranch,
    },
  });
  const basePolicy = resolveExecutionPolicy({
    launchOverride: selection.executionPolicy,
    taskDefault: task.executionPolicy,
    projectDefault: project.executionPolicyDefault,
  });
  const executionPolicy = applyDefaultBudgetForUnattended(
    execution?.agentPolicyOverlay
      ? resolveAgentExecutionPolicy({
          instanceOverride: execution.agentPolicyOverlay,
          base: basePolicy,
        })
      : basePolicy,
  );

  assertNoBlindShip(executionPolicy);

  return {
    version: 2,
    kind: "flow",
    workspace: "worktree",
    agentId: null,
    definitionSha256: null,
    flowId: flow.id,
    flowRefId: flow.flowRefId,
    flowRevisionId: revision.id,
    packageInstallId,
    sessions: [...sessions, ...consensus],
    baseBranch,
    targetBranch,
    deliveryPolicy,
    executionPolicy,
    promotionMode:
      deliveryPolicy.strategy === "ai_rebase_merge"
        ? "rebase_merge"
        : legacyPromotionModeFromStrategy(deliveryPolicy.strategy),
    autoPromote: selection.autoPromote ?? true,
    brainContext: selection.brainContext ?? null,
    packageVersions: selection.packageVersions ?? {},
    ...(source ? { serverExecution: source } : {}),
    relaunchSource: selection.relaunchOfRunId
      ? await captureConcurrentTaskLaunchRelaunchSource(db, {
          sourceRunId: selection.relaunchOfRunId,
          projectId: project.id,
          taskId: task.id,
        })
      : null,
    ...(await resolveTaskLaunchCapabilities(db, {
      projectId: project.id,
      flowRevisionId: revision.id,
      flowSource: revision.source,
    })),
    taskSettingsDigest: retryDigest(taskLaunchSelectedConfiguration(task)),
    resolutionToken: source
      ? retryDigest({
          version: 1,
          settingsToken: await taskLaunchSettingsMetadataToken(
            db,
            task.id,
            selection,
          ),
          source,
          revision: {
            id: revision.id,
            manifestDigest: revision.manifestDigest,
            manifestContentDigest: retryDigest(revision.manifest),
            packageStatus: revision.packageStatus,
          },
          sessions: [...sessions, ...consensus],
          executionPolicy,
          deliveryPolicy,
          baseBranch,
          targetBranch,
        })
      : await taskLaunchSettingsMetadataToken(db, task.id, selection),
  };
}
