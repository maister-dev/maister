import "server-only";

import type { FlowYamlV1 } from "@/lib/config.schema";

import { and, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import pino from "pino";
import { z } from "zod";

import { requireActiveSession, requireProjectAction } from "@/lib/authz";
import {
  resolveCompiledStepTargetRunnerId,
  type FlowRunnerRemapRow,
} from "@/lib/acp-runners/flow-step-target";
import {
  resolveRunner,
  type RunnerCatalogEntry,
} from "@/lib/acp-runners/resolve";
import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { isMaisterError, MaisterError } from "@/lib/errors";
import {
  isEngineCompatible,
  isSchemaVersionSupported,
} from "@/lib/flows/engine-version";
import { compileManifest } from "@/lib/flows/graph/compile";
import {
  classifyManualTaskLaunchability,
  getLatestFlowRun,
} from "@/lib/runs/launchability";
import {
  resolveDeliveryPolicy,
  type StoredDeliveryPolicy,
} from "@/lib/runs/delivery-policy";
import {
  resolveExecutionPolicy,
  type ExecutionPolicy,
} from "@/lib/runs/execution-policy";
import { getOpenRelationBlockers } from "@/lib/social/relations";
import { listBranches } from "@/lib/worktree";

const {
  flowRevisions,
  flowRunnerRemaps,
  flows,
  platformAcpRunners,
  platformRuntimeSettings,
  projectFlowRunnerDefaults,
  projects,
  tasks,
} = schemaModule as unknown as Record<string, any>;

const log = pino({
  name: "api-runs-launch-options",
  level: process.env.LOG_LEVEL ?? "info",
});

const querySchema = z.object({ taskId: z.string().min(1) }).strict();

function httpStatusForCode(code: string): number {
  switch (code) {
    case "UNAUTHENTICATED":
      return 401;
    case "UNAUTHORIZED":
    case "PASSWORD_CHANGE_REQUIRED":
    case "ACCOUNT_INACTIVE":
      return 403;
    case "CONFIG":
      return 422;
    case "PRECONDITION":
    case "CONFLICT":
      return 409;
    case "EXECUTOR_UNAVAILABLE":
      return 503;
    default:
      return 500;
  }
}

function errorResponse(err: unknown): NextResponse {
  if (isMaisterError(err)) {
    return NextResponse.json(
      { code: err.code, message: err.message },
      { status: httpStatusForCode(err.code) },
    );
  }

  log.error(
    { err: err instanceof Error ? err.message : String(err) },
    "GET /api/runs/launch-options unhandled error",
  );

  return NextResponse.json(
    { code: "CRASH", message: "internal error" },
    { status: 500 },
  );
}

function runnerCatalogEntry(row: Record<string, any>): RunnerCatalogEntry {
  return {
    id: row.id,
    adapter: row.adapter,
    capabilityAgent: row.capabilityAgent,
    model: row.model,
    providerKind: runnerProviderKind(row.provider),
    permissionPolicy: row.permissionPolicy,
    sidecarId: row.sidecarId,
    enabled: row.enabled,
    ready: row.readinessStatus === "Ready",
  };
}

function runnerProviderKind(provider: unknown): string {
  if (
    provider &&
    typeof provider === "object" &&
    "kind" in provider &&
    typeof provider.kind === "string"
  ) {
    return provider.kind;
  }

  throw new MaisterError(
    "CONFIG",
    `platform ACP runner has invalid provider payload: ${JSON.stringify(provider)}`,
  );
}

function assertRevisionLaunchable(
  flow: Record<string, any>,
  revision: Record<string, any>,
) {
  if (revision.packageStatus !== "Installed") {
    throw new MaisterError(
      "PRECONDITION",
      `flow "${flow.flowRefId}" enabled revision is ${revision.packageStatus}, not Installed`,
    );
  }
  if (revision.setupStatus === "pending" || revision.setupStatus === "failed") {
    throw new MaisterError(
      "PRECONDITION",
      `flow "${flow.flowRefId}" package setup is ${revision.setupStatus}`,
    );
  }
  if (!isSchemaVersionSupported(revision.schemaVersion)) {
    throw new MaisterError(
      "CONFIG",
      `flow "${flow.flowRefId}" requires unsupported manifest schemaVersion ${revision.schemaVersion}`,
    );
  }

  const compat = isEngineCompatible(
    revision.engineMin ?? undefined,
    revision.engineMax ?? undefined,
  );

  if (!compat.compatible) {
    throw new MaisterError(
      "CONFIG",
      `flow "${flow.flowRefId}" is incompatible with this MAIster engine: ${compat.reason}`,
    );
  }
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const parsed = querySchema.safeParse({
    taskId: req.nextUrl.searchParams.get("taskId"),
  });

  if (!parsed.success) {
    return errorResponse(
      new MaisterError("CONFIG", `invalid query: ${parsed.error.message}`),
    );
  }

  try {
    await requireActiveSession();

    const db = getDb() as any;
    const taskRows = await db
      .select()
      .from(tasks)
      .where(eq(tasks.id, parsed.data.taskId));
    const task = taskRows[0];

    if (!task) {
      throw new MaisterError(
        "PRECONDITION",
        `task not found: ${parsed.data.taskId}`,
      );
    }

    const projectRows = await db
      .select()
      .from(projects)
      .where(eq(projects.id, task.projectId));
    const project = projectRows[0];

    if (!project || project.archivedAt) {
      throw new MaisterError("PRECONDITION", "project not found for task");
    }

    await requireProjectAction(project.id, "launchRun");

    // M34 (ADR-089): a flowless simple-intent task still gets options — the
    // popover doubles as the "set up & launch" dialog (the flow pick PATCHes
    // the task before the run POST).
    const flowRows = task.flowId
      ? await db.select().from(flows).where(eq(flows.id, task.flowId))
      : [];
    const flow = flowRows[0] ?? null;

    let revision: Record<string, any> | null = null;

    if (flow) {
      if (!flow.enabledRevisionId) {
        throw new MaisterError("PRECONDITION", "flow has no enabled revision");
      }

      const revisionRows = await db
        .select()
        .from(flowRevisions)
        .where(eq(flowRevisions.id, flow.enabledRevisionId));

      revision = revisionRows[0] ?? null;

      if (!revision) {
        throw new MaisterError(
          "PRECONDITION",
          "enabled flow revision not found",
        );
      }

      assertRevisionLaunchable(flow, revision);
    }

    const [
      runtimeRows,
      runnerRows,
      projectFlowDefaultRows,
      remapRows,
      flowRowsForProject,
    ] = await Promise.all([
      db
        .select()
        .from(platformRuntimeSettings)
        .where(eq(platformRuntimeSettings.id, "singleton")),
      db.select().from(platformAcpRunners),
      flow
        ? db
            .select({ runnerId: projectFlowRunnerDefaults.runnerId })
            .from(projectFlowRunnerDefaults)
            .where(
              and(
                eq(projectFlowRunnerDefaults.projectId, project.id),
                eq(projectFlowRunnerDefaults.flowId, flow.id),
              ),
            )
        : Promise.resolve([]),
      revision
        ? db
            .select({
              stepId: flowRunnerRemaps.stepId,
              sourceRunnerId: flowRunnerRemaps.sourceRunnerId,
              mappedRunnerId: flowRunnerRemaps.mappedRunnerId,
              status: flowRunnerRemaps.status,
            })
            .from(flowRunnerRemaps)
            .where(
              and(
                eq(flowRunnerRemaps.projectId, project.id),
                eq(flowRunnerRemaps.flowRevisionId, revision.id),
              ),
            )
        : Promise.resolve([]),
      db.select().from(flows).where(eq(flows.projectId, project.id)),
    ]);
    const platformRuntime = runtimeRows[0];

    if (!platformRuntime) {
      throw new MaisterError(
        "EXECUTOR_UNAVAILABLE",
        "platform default ACP runner is not configured",
      );
    }

    const runnerCatalog = runnerRows.map(runnerCatalogEntry);
    const defaultResolution = resolveRunner({
      launchOverrideRunnerId: undefined,
      step: {
        runnerId: revision
          ? resolveCompiledStepTargetRunnerId({
              compiled: compileManifest(revision.manifest as FlowYamlV1),
              remaps: remapRows as FlowRunnerRemapRow[],
              flowRefId: flow.flowRefId,
            })
          : null,
      },
      projectFlow: {
        defaultRunnerId: projectFlowDefaultRows[0]?.runnerId ?? null,
      },
      platformFlow: { defaultRunnerId: revision?.defaultRunnerId ?? null },
      project: { defaultRunnerId: project.defaultRunnerId },
      platform: { defaultRunnerId: platformRuntime.defaultRunnerId },
      runners: runnerCatalog,
    });
    const latestFlowRun = await getLatestFlowRun(task.id, db);
    const openBlockers =
      (await getOpenRelationBlockers([task.id], db)).get(task.id) ?? [];
    const manualLaunchability = classifyManualTaskLaunchability(
      {
        status: task.status ?? "Backlog",
      },
      latestFlowRun,
      { openBlockers },
    );
    // M34 (ADR-089): a flowless task layers `unconfigured` over launchable —
    // the popover's flow pick clears it (set-up & launch).
    const launchability =
      manualLaunchability === "launchable" && !task.flowId
        ? "unconfigured"
        : manualLaunchability;
    const branches = await listBranches(project.repoPath, {
      includeRemotes: true,
    });
    const projectPolicy = resolveDeliveryPolicy({
      projectDefault:
        project.deliveryPolicyDefault as StoredDeliveryPolicy | null,
      projectPromotionMode: project.promotionMode,
      projectMainBranch: project.mainBranch ?? "main",
    });
    // M34 (ADR-089): the triage verdict pre-fills the dialog — runner rides
    // the launchOverride tier, target branch + promotion mode shape the
    // delivery-policy default. Nothing applies without the user's confirm.
    const verdictTargetBranch = (task.targetBranch as string | null) ?? null;
    const deliveryPolicyDefault = {
      ...projectPolicy,
      ...(task.promotionMode
        ? {
            strategy:
              task.promotionMode === "pull_request"
                ? ("pull_request" as const)
                : ("merge" as const),
          }
        : {}),
      ...(verdictTargetBranch ? { targetBranch: verdictTargetBranch } : {}),
    };
    // Resolved execution-control default for the dialog (no launch override at
    // options time). Preset + per-axis option enums are client-side constants
    // the launch UI imports directly from @/lib/runs/execution-policy.
    const executionPolicyDefault = resolveExecutionPolicy({
      taskDefault: (task.executionPolicy as ExecutionPolicy | null) ?? null,
      projectDefault:
        (project.executionPolicyDefault as ExecutionPolicy | null) ?? null,
    });
    const safeRunners = runnerRows.map((runner: Record<string, any>) => ({
      id: runner.id,
      label: runner.id,
      adapter: runner.adapter,
      capabilityAgent: runner.capabilityAgent,
      model: runner.model,
      providerKind: runnerProviderKind(runner.provider),
      permissionPolicy: runner.permissionPolicy,
      sidecarId: runner.sidecarId,
      readinessStatus: runner.readinessStatus,
      readinessReasons: runner.readinessReasons,
      enabled: runner.enabled,
      pinnedModel: {
        model: runner.model,
        source:
          runner.id === defaultResolution.runnerId
            ? defaultResolution.runnerResolutionTier
            : "runner",
      },
    }));

    return NextResponse.json({
      taskId: task.id,
      flowId: flow?.id ?? null,
      flowRef: flow?.flowRefId ?? null,
      defaultRunnerId: defaultResolution.runnerId,
      runnerResolutionTier: defaultResolution.runnerResolutionTier,
      runners: safeRunners,
      task: {
        id: task.id,
        projectId: project.id,
        projectSlug: project.slug,
        number: task.number,
        status: task.status ?? "Backlog",
        flowId: task.flowId,
      },
      launchability: {
        launchable: launchability === "launchable",
        reason: launchability,
        blockers: openBlockers.map(
          (blocker: { key: string; number: number }) => ({
            kind: "relation",
            label: `${blocker.key}-${blocker.number}`,
          }),
        ),
      },
      flows: flowRowsForProject.map((projectFlow: Record<string, any>) => ({
        id: projectFlow.id,
        refId: projectFlow.flowRefId,
        name: projectFlow.flowRefId,
        version: projectFlow.version ?? null,
        enabled: projectFlow.enablementState !== "Disabled",
        isTaskDefault: projectFlow.id === task.flowId,
      })),
      selectedFlowId: flow?.id ?? "",
      selectedRunnerId:
        (task.runnerId as string | null) ?? defaultResolution.runnerId,
      branches,
      defaultBaseBranch: project.mainBranch ?? null,
      defaultTargetBranch: verdictTargetBranch ?? project.mainBranch ?? null,
      deliveryPolicyDefault,
      executionPolicyDefault,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
