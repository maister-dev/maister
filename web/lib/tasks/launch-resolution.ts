import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { TaskLaunchRequest } from "./launch-schema";
import type { TaskLaunchSettingsV2Snapshot } from "./launch-types";

import { and, eq } from "drizzle-orm";

import { resolveTaskLaunchCapabilities } from "./launch-capabilities";

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
import { classifyStoredFlowManifest } from "@/lib/flows/manifest-parser";
import { assertFlowLaunchable } from "@/lib/flows/launchability-gate";
import {
  resolveDeliveryPolicy,
  legacyPromotionModeFromStrategy,
} from "@/lib/runs/delivery-policy";
import {
  resolveExecutionPolicy,
  assertNoBlindShip,
} from "@/lib/runs/execution-policy";
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

/** Read-only config fence, including the current immutable Flow and runner identities. */
export async function taskLaunchSettingsToken(
  db: Db,
  taskId: string,
): Promise<string> {
  const [row] = await db
    .select({ task: tasks, project: projects })
    .from(tasks)
    .innerJoin(projects, eq(projects.id, tasks.projectId))
    .where(eq(tasks.id, taskId));

  if (!row) throw launchRefusal("launch_task_missing", "PRECONDITION");
  const [flow] = row.task.flowId
    ? await db.select().from(flows).where(eq(flows.id, row.task.flowId))
    : [];
  const [revision] = flow?.enabledRevisionId
    ? await db
        .select()
        .from(flowRevisions)
        .where(eq(flowRevisions.id, flow.enabledRevisionId))
    : [];
  const catalog = await loadRunnerCatalog(db);
  const [runtime] = await db
    .select()
    .from(platformRuntimeSettings)
    .where(eq(platformRuntimeSettings.id, "singleton"));
  const bindings = flow?.enabledRevisionId
    ? await loadFlowRunnerBindings(db, row.project.id, flow.enabledRevisionId)
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
    flow: flow
      ? {
          id: flow.id,
          revision: flow.enabledRevisionId,
          state: flow.enablementState,
          packageInstallId: flow.packageInstallId,
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

type ResolvedFlowLaunchSettings = Omit<
  Extract<TaskLaunchSettingsV2Snapshot, { kind: "flow" }>,
  "baseCommit"
>;

/** Resolve through the existing Flow runner/policy authorities; never materialize or launch. */
export async function resolveFlowLaunchSettings(
  db: Db,
  task: typeof tasks.$inferSelect,
  project: typeof projects.$inferSelect,
  selection: Partial<TaskLaunchRequest>,
): Promise<ResolvedFlowLaunchSettings> {
  const flowId = selection.flowId ?? task.flowId;

  if (!flowId) throw launchRefusal("unconfigured", "PRECONDITION");
  const [flow] = await db
    .select()
    .from(flows)
    .where(and(eq(flows.id, flowId), eq(flows.projectId, project.id)));

  if (!flow) throw launchRefusal("flow_unavailable", "PRECONDITION");
  const [revision] = flow.enabledRevisionId
    ? await db
        .select()
        .from(flowRevisions)
        .where(eq(flowRevisions.id, flow.enabledRevisionId))
    : [];

  assertFlowLaunchable(flow.flowRefId, flow, revision ?? null);
  if (!revision) throw launchRefusal("flow_unavailable", "PRECONDITION");
  const compatibility = classifyStoredFlowManifest(revision.manifest);

  if (!compatibility.compatible)
    throw launchRefusal("flow_incompatible", "PRECONDITION");
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
    manifest: compatibility.manifest,
    bindings: await loadFlowRunnerBindings(db, project.id, revision.id),
    taskRunnerId: task.runnerId,
    launchOverrideRunnerId: selection.runnerId,
    projectFlow: { defaultRunnerId: defaults?.runnerId ?? null },
    platformFlow: { defaultRunnerId: revision.defaultRunnerId },
    project: { defaultRunnerId: project.defaultRunnerId },
    platform: { defaultRunnerId: runtime.defaultRunnerId },
    runners: await loadRunnerCatalog(db),
  });
  const sessions = inspection.sessions.map((session) => {
    if (session.status === "unresolved") throw session.error;
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
    };
  });
  const consensus = inspection.consensus.map((slot) => {
    if (slot.status === "unresolved") throw slot.error;
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
    };
  });
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
    launchOverride: { ...selection.deliveryPolicy, targetBranch },
  });
  const executionPolicy = applyDefaultBudgetForUnattended(
    resolveExecutionPolicy({
      launchOverride: selection.executionPolicy,
      taskDefault: task.executionPolicy,
      projectDefault: project.executionPolicyDefault,
    }),
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
    packageInstallId: flow.packageInstallId,
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
    ...(await resolveTaskLaunchCapabilities(db, {
      projectId: project.id,
      flowRevisionId: revision.id,
      flowSource: revision.source,
    })),
    taskSettingsDigest: retryDigest(taskLaunchConfiguration(task, project)),
    resolutionToken: await taskLaunchSettingsToken(db, task.id),
  };
}
