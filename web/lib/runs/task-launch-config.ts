import "server-only";

import type { FlowYamlV1 } from "@/lib/config.schema";
import type {
  RunnerCatalogEntry,
  RunnerResolutionTier,
} from "@/lib/acp-runners/resolve";
import type {
  DeliveryPolicy,
  StoredDeliveryPolicy,
} from "@/lib/runs/delivery-policy";
import type { ExecutionPolicy } from "@/lib/runs/execution-policy";

import { and, eq } from "drizzle-orm";

import { loadFlowRunnerBindings } from "@/lib/acp-runners/catalog";
import { resolveRunSessions } from "@/lib/acp-runners/resolve";
import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import {
  isEngineCompatible,
  isSchemaVersionSupported,
} from "@/lib/flows/engine-version";
import { compileManifest } from "@/lib/flows/graph/compile";
import { resolveDeliveryPolicy } from "@/lib/runs/delivery-policy";
import { resolveExecutionPolicy } from "@/lib/runs/execution-policy";
import {
  classifyManualTaskLaunchability,
  getLatestFlowRun,
} from "@/lib/runs/launchability";
import { getOpenRelationBlockers } from "@/lib/social/relations";

const {
  flowRevisions,
  flows,
  platformAcpRunners,
  platformRuntimeSettings,
  projectFlowRunnerDefaults,
  projects,
  tasks,
} = schemaModule as unknown as Record<string, any>;

const LAUNCHABLE_FLOW_ENABLEMENT_STATES = new Set<string>([
  "Enabled",
  "UpdateAvailable",
]);

export type TaskLaunchConfig = {
  flow: { id: string; refId: string } | null;
  // `null` when fully launchable; otherwise a typed reason the page can label.
  flowIssue:
    | "unconfigured"
    | "flow_missing"
    | "no_revision"
    | "not_enabled"
    | "not_installed"
    | "unsupported_schema"
    | "incompatible"
    | null;
  runner: { id: string; model: string; adapter: string } | null;
  runnerTier: RunnerResolutionTier | "task" | null;
  baseBranch: string;
  targetBranch: string;
  deliveryPolicy: DeliveryPolicy;
  launchable: boolean;
  launchReason: string;
  executionPolicy: ExecutionPolicy;
};

function providerKind(provider: unknown): string {
  if (
    provider &&
    typeof provider === "object" &&
    "kind" in provider &&
    typeof (provider as { kind?: unknown }).kind === "string"
  ) {
    return (provider as { kind: string }).kind;
  }

  return "unknown";
}

function runnerCatalogEntry(row: Record<string, any>): RunnerCatalogEntry {
  return {
    id: row.id,
    adapter: row.adapter,
    capabilityAgent: row.capabilityAgent,
    model: row.model,
    env: row.env,
    providerKind: providerKind(row.provider),
    permissionPolicy: row.permissionPolicy,
    sidecarId: row.sidecarId,
    enabled: row.enabled,
    ready: row.readinessStatus === "Ready",
  };
}

// Read-only mirror of the launch resolution in
// `app/api/runs/launch-options/route.ts` (the source of truth for what a launch
// uses). Unlike that route it NEVER throws on a non-launchable flow/runner — it
// degrades to a typed `flowIssue` / `runner: null` so the task page renders the
// config it can resolve. Keep the runner-tier order and delivery-policy layering
// in sync with that route.
export async function resolveTaskLaunchConfig(
  taskId: string,
): Promise<TaskLaunchConfig | null> {
  const db = getDb() as any;

  const task = (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0];

  if (!task) return null;

  const project = (
    await db.select().from(projects).where(eq(projects.id, task.projectId))
  )[0];

  if (!project) return null;

  const mainBranch = project.mainBranch ?? "main";
  const baseBranch = (task.baseBranch as string | null) ?? mainBranch;

  let flowRow: Record<string, any> | null = null;
  let revision: Record<string, any> | null = null;
  let flowIssue: TaskLaunchConfig["flowIssue"] = task.flowId
    ? null
    : "unconfigured";

  if (task.flowId) {
    flowRow =
      (await db.select().from(flows).where(eq(flows.id, task.flowId)))[0] ??
      null;

    if (!flowRow) {
      flowIssue = "flow_missing";
    } else if (!flowRow.enabledRevisionId) {
      flowIssue = "no_revision";
    } else if (
      !LAUNCHABLE_FLOW_ENABLEMENT_STATES.has(flowRow.enablementState)
    ) {
      flowIssue = "not_enabled";
    } else {
      revision =
        (
          await db
            .select()
            .from(flowRevisions)
            .where(eq(flowRevisions.id, flowRow.enabledRevisionId))
        )[0] ?? null;

      if (!revision) {
        flowIssue = "no_revision";
      } else if (revision.packageStatus !== "Installed") {
        flowIssue = "not_installed";
      } else if (!isSchemaVersionSupported(revision.schemaVersion)) {
        flowIssue = "unsupported_schema";
      } else if (
        !isEngineCompatible(
          revision.engineMin ?? undefined,
          revision.engineMax ?? undefined,
        ).compatible
      ) {
        flowIssue = "incompatible";
      }
    }
  }

  const [runtimeRows, runnerRows, projectFlowDefaultRows, bindings] =
    await Promise.all([
      db
        .select()
        .from(platformRuntimeSettings)
        .where(eq(platformRuntimeSettings.id, "singleton")),
      db.select().from(platformAcpRunners),
      flowRow
        ? db
            .select({ runnerId: projectFlowRunnerDefaults.runnerId })
            .from(projectFlowRunnerDefaults)
            .where(
              and(
                eq(projectFlowRunnerDefaults.projectId, project.id),
                eq(projectFlowRunnerDefaults.flowId, flowRow.id),
              ),
            )
        : Promise.resolve([]),
      revision
        ? loadFlowRunnerBindings(db, project.id, revision.id)
        : Promise.resolve([]),
    ]);
  const platformRuntime = runtimeRows[0];
  const runnerCatalog = runnerRows.map(runnerCatalogEntry);

  let resolvedDefaultId: string | null = null;
  let resolvedTier: RunnerResolutionTier | null = null;

  // M42 (ADR-114): the card shows the run's `default` session runner (the
  // single-runner case). A flow whose default session cannot resolve degrades
  // to `null` — the card just shows no runner, never throws.
  if (platformRuntime?.defaultRunnerId && revision && flowRow) {
    try {
      const sessions = [
        ...compileManifest(revision.manifest as FlowYamlV1).sessions.values(),
      ];
      const defaultSession =
        sessions.find((session) => session.name === "default") ?? sessions[0];

      if (defaultSession) {
        const [resolution] = resolveRunSessions({
          sessions: [defaultSession],
          runnerProfiles: (revision.manifest as FlowYamlV1).runner_profiles,
          bindings,
          projectFlow: {
            defaultRunnerId: projectFlowDefaultRows[0]?.runnerId ?? null,
          },
          platformFlow: { defaultRunnerId: revision.defaultRunnerId ?? null },
          project: { defaultRunnerId: project.defaultRunnerId },
          platform: { defaultRunnerId: platformRuntime.defaultRunnerId },
          runners: runnerCatalog,
        });

        resolvedDefaultId = resolution.runnerId;
        resolvedTier = resolution.runnerResolutionTier;
      }
    } catch {
      resolvedDefaultId = null;
    }
  }

  const effectiveRunnerId =
    (task.runnerId as string | null) ?? resolvedDefaultId;
  const effectiveRunnerRow = effectiveRunnerId
    ? (runnerRows.find(
        (row: Record<string, any>) => row.id === effectiveRunnerId,
      ) ?? null)
    : null;
  const runner = effectiveRunnerRow
    ? {
        id: effectiveRunnerRow.id,
        model: effectiveRunnerRow.model,
        adapter: effectiveRunnerRow.adapter,
      }
    : null;

  const projectPolicy = resolveDeliveryPolicy({
    projectDefault:
      project.deliveryPolicyDefault as StoredDeliveryPolicy | null,
    projectPromotionMode: project.promotionMode,
    projectMainBranch: mainBranch,
  });
  const verdictTargetBranch = (task.targetBranch as string | null) ?? null;
  const targetBranch = verdictTargetBranch ?? baseBranch;
  const deliveryPolicy: DeliveryPolicy = {
    ...projectPolicy,
    ...(task.promotionMode
      ? {
          strategy:
            task.promotionMode === "pull_request"
              ? ("pull_request" as const)
              : ("merge" as const),
        }
      : {}),
    targetBranch,
  };
  const executionPolicy = resolveExecutionPolicy({
    taskDefault: (task.executionPolicy as ExecutionPolicy | null) ?? null,
    projectDefault:
      (project.executionPolicyDefault as ExecutionPolicy | null) ?? null,
  });

  const latestFlowRun = await getLatestFlowRun(task.id, db);
  const openBlockers =
    (await getOpenRelationBlockers([task.id], db)).get(task.id) ?? [];
  const manual = classifyManualTaskLaunchability(
    {
      status: task.status ?? "Backlog",
      triageStatus: (task.triageStatus as "triaged" | "flagged" | null) ?? null,
    },
    latestFlowRun,
    { openBlockers },
  );
  const launchReason =
    manual === "launchable" && !task.flowId ? "unconfigured" : manual;

  return {
    flow: flowRow ? { id: flowRow.id, refId: flowRow.flowRefId } : null,
    flowIssue,
    runner,
    runnerTier: task.runnerId ? "task" : resolvedTier,
    baseBranch,
    targetBranch,
    deliveryPolicy,
    launchable: manual === "launchable",
    launchReason,
    executionPolicy,
  };
}
