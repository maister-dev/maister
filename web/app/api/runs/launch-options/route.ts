import "server-only";

import type { FlowYamlV1 } from "@/lib/config.schema";

import { and, eq, inArray } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import pino from "pino";
import { z } from "zod";

import { requireActiveSession, requireProjectAction } from "@/lib/authz";
import { loadFlowRunnerBindings } from "@/lib/acp-runners/catalog";
import {
  resolveRunner,
  resolveRunSessions,
  type RunnerCatalogEntry,
  type RunSessionSlot,
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
import { detectAvailablePackageVersions } from "@/lib/local-packages/versions";
import { getOpenRelationBlockers } from "@/lib/social/relations";
import { listBranches } from "@/lib/worktree";

const {
  flowRevisions,
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

type FlowLaunchIssue =
  | "unconfigured"
  | "flow_missing"
  | "no_revision"
  | "not_enabled"
  | "not_installed"
  | "setup_failed"
  | "setup_pending"
  | "unsupported_schema"
  | "incompatible";

const LAUNCHABLE_FLOW_ENABLEMENT_STATES = new Set<string>([
  "Enabled",
  "UpdateAvailable",
]);

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
    env: row.env,
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

function revisionLaunchIssue(
  revision: Record<string, any>,
): FlowLaunchIssue | null {
  if (revision.packageStatus !== "Installed") {
    return "not_installed";
  }
  if (revision.setupStatus === "pending") {
    return "setup_pending";
  }
  if (revision.setupStatus === "failed") {
    return "setup_failed";
  }
  if (!isSchemaVersionSupported(revision.schemaVersion)) {
    return "unsupported_schema";
  }

  const compat = isEngineCompatible(
    revision.engineMin ?? undefined,
    revision.engineMax ?? undefined,
  );

  if (!compat.compatible) {
    return "incompatible";
  }

  return null;
}

function projectFlowLaunchIssue(args: {
  projectFlow: Record<string, any>;
  revisionById: Map<string, Record<string, any>>;
}): FlowLaunchIssue | null {
  const enabledRevisionId = args.projectFlow.enabledRevisionId as
    | string
    | null
    | undefined;

  if (!enabledRevisionId) {
    return "no_revision";
  }
  if (
    !LAUNCHABLE_FLOW_ENABLEMENT_STATES.has(
      args.projectFlow.enablementState as string,
    )
  ) {
    return "not_enabled";
  }

  const projectRevision = args.revisionById.get(enabledRevisionId);

  if (!projectRevision) {
    return "no_revision";
  }

  return revisionLaunchIssue(projectRevision);
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
    // the task before the run POST). The same response shape is useful for an
    // already-selected flow that cannot launch anymore: users can still change
    // the saved Flow/runner defaults instead of getting a dead dialog.
    const flowRows = task.flowId
      ? await db.select().from(flows).where(eq(flows.id, task.flowId))
      : [];
    const flow = flowRows[0] ?? null;

    let revision: Record<string, any> | null = null;
    let flowIssue: FlowLaunchIssue | null = task.flowId
      ? flow
        ? null
        : "flow_missing"
      : "unconfigured";

    if (flow) {
      if (!flow.enabledRevisionId) {
        flowIssue = "no_revision";
      } else if (!LAUNCHABLE_FLOW_ENABLEMENT_STATES.has(flow.enablementState)) {
        flowIssue = "not_enabled";
      } else {
        const revisionRows = await db
          .select()
          .from(flowRevisions)
          .where(eq(flowRevisions.id, flow.enabledRevisionId));

        revision = revisionRows[0] ?? null;

        if (!revision) {
          flowIssue = "no_revision";
        } else {
          flowIssue = revisionLaunchIssue(revision);
        }
      }
    }

    const [
      runtimeRows,
      runnerRows,
      projectFlowDefaultRows,
      bindings,
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
      revision && flowIssue === null
        ? loadFlowRunnerBindings(db, project.id, revision.id)
        : Promise.resolve([]),
      db.select().from(flows).where(eq(flows.projectId, project.id)),
    ]);
    const platformRuntime = runtimeRows[0];

    const projectEnabledRevisionIds = Array.from(
      new Set(
        flowRowsForProject
          .map(
            (projectFlow: Record<string, any>) => projectFlow.enabledRevisionId,
          )
          .filter(
            (enabledRevisionId: unknown): enabledRevisionId is string =>
              typeof enabledRevisionId === "string" &&
              enabledRevisionId.length > 0,
          ),
      ),
    );
    const projectRevisionRows =
      projectEnabledRevisionIds.length > 0
        ? await db
            .select()
            .from(flowRevisions)
            .where(inArray(flowRevisions.id, projectEnabledRevisionIds))
        : [];
    const projectRevisionById = new Map<string, Record<string, any>>(
      projectRevisionRows.map((projectRevision: Record<string, any>) => [
        projectRevision.id as string,
        projectRevision,
      ]),
    );

    if (!platformRuntime) {
      throw new MaisterError(
        "EXECUTOR_UNAVAILABLE",
        "platform default ACP runner is not configured",
      );
    }

    const runnerCatalog = runnerRows.map(runnerCatalogEntry);
    const defaultChain = {
      projectFlow: {
        defaultRunnerId: projectFlowDefaultRows[0]?.runnerId ?? null,
      },
      platformFlow: { defaultRunnerId: revision?.defaultRunnerId ?? null },
      project: { defaultRunnerId: project.defaultRunnerId },
      platform: { defaultRunnerId: platformRuntime.defaultRunnerId },
    } as const;
    // The dialog's single "default runner" is the implicit `default` session;
    // it always resolves through the project/platform default chain.
    const fallbackResolution = resolveRunner({
      launchOverrideRunnerId: undefined,
      step: { runnerId: null },
      ...defaultChain,
      runners: runnerCatalog,
    });

    // M42 (ADR-114): resolve EVERY logical session of the selected flow. A slot
    // that cannot resolve (unbound / ambiguous / no host) degrades to
    // `runnerId: null` so the options dialog still renders (the binding screen
    // resolves it) instead of 5xx-ing the whole preview.
    const runnerProfiles =
      revision && flowIssue === null
        ? (revision.manifest as FlowYamlV1).runner_profiles
        : undefined;
    const sessionSlots: RunSessionSlot[] =
      revision && flow && flowIssue === null
        ? [
            ...compileManifest(
              revision.manifest as FlowYamlV1,
            ).sessions.values(),
          ]
        : [];
    const sessionResolutions = sessionSlots.map((session) => {
      try {
        const [resolution] = resolveRunSessions({
          sessions: [session],
          runnerProfiles,
          bindings,
          ...defaultChain,
          runners: runnerCatalog,
        });

        return {
          sessionName: session.name,
          runnerId: resolution.runnerId as string | null,
          tier: resolution.runnerResolutionTier as string,
        };
      } catch {
        return { sessionName: session.name, runnerId: null, tier: null };
      }
    });
    const defaultSession =
      sessionResolutions.find((s) => s.sessionName === "default") ??
      sessionResolutions[0];
    const defaultResolution =
      defaultSession?.runnerId && defaultSession.tier
        ? {
            runnerId: defaultSession.runnerId,
            runnerResolutionTier: defaultSession.tier,
          }
        : {
            runnerId: fallbackResolution.runnerId,
            runnerResolutionTier:
              fallbackResolution.runnerResolutionTier as string,
          };
    const latestFlowRun = await getLatestFlowRun(task.id, db);
    const openBlockers =
      (await getOpenRelationBlockers([task.id], db)).get(task.id) ?? [];
    const manualLaunchability = classifyManualTaskLaunchability(
      {
        status: task.status ?? "Backlog",
        triageStatus:
          (task.triageStatus as "triaged" | "flagged" | null) ?? null,
      },
      latestFlowRun,
      { openBlockers },
    );
    // M34 (ADR-089): flow setup issues layer over an otherwise-launchable task.
    // Run-state/relation blockers keep their precedence; users can still load
    // the options response and edit away from a stale/broken flow.
    const launchability =
      manualLaunchability === "launchable"
        ? (flowIssue ?? "launchable")
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
    const defaultBaseBranch =
      (task.baseBranch as string | null) ?? project.mainBranch ?? "main";
    const verdictTargetBranch = (task.targetBranch as string | null) ?? null;
    const defaultTargetBranch = verdictTargetBranch ?? defaultBaseBranch;
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
      targetBranch: defaultTargetBranch,
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

    // M39 Stream B (ADR-107): the project's attached centralized packages that
    // have a newer cut and/or uncut Studio edits — the launch dialog's
    // keep/adopt/cut_and_adopt choices. Empty for projects with no such packages
    // (no git calls), so this is free for the common case.
    const availablePackageVersions = await detectAvailablePackageVersions({
      projectId: project.id,
      db: db as never,
    });

    return NextResponse.json({
      runners: safeRunners,
      // M42 (ADR-114): one entry per logical session of the selected flow, each
      // with its resolved runner; empty for a single-session flow (the single
      // `selectedRunnerId` selector covers it). `overridable` advertises the
      // ephemeral per-run override offered at the Launch dialog.
      sessions:
        sessionResolutions.length > 1
          ? sessionResolutions.map((session) => ({
              sessionName: session.sessionName,
              runnerId: session.runnerId,
              label: session.sessionName,
              overridable: true,
            }))
          : [],
      task: {
        id: task.id,
        projectId: project.id,
        projectSlug: project.slug,
        number: task.number,
        status: task.status ?? "Backlog",
        flowId: task.flowId,
      },
      launchability: {
        launchable: launchability === "launchable" && flowIssue === null,
        reason: launchability,
        blockers: openBlockers.map(
          (blocker: { key: string; number: number }) => ({
            kind: "relation",
            label: `${blocker.key}-${blocker.number}`,
          }),
        ),
      },
      flows: flowRowsForProject.map((projectFlow: Record<string, any>) => {
        const disabledReason = projectFlowLaunchIssue({
          projectFlow,
          revisionById: projectRevisionById,
        });

        return {
          id: projectFlow.id,
          refId: projectFlow.flowRefId,
          name: projectFlow.flowRefId,
          version: projectFlow.version ?? null,
          enabled: disabledReason === null,
          disabledReason,
          isTaskDefault: projectFlow.id === task.flowId,
        };
      }),
      selectedFlowId: flow?.id ?? "",
      selectedRunnerId:
        (task.runnerId as string | null) ?? defaultResolution.runnerId,
      branches,
      defaultBaseBranch,
      defaultTargetBranch,
      deliveryPolicyDefault,
      executionPolicyDefault,
      availablePackageVersions,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
