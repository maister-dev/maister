import "server-only";

import type { CapabilityAgent, FlowYamlV1 } from "@/lib/config.schema";

import { randomUUID } from "node:crypto";
import path from "node:path";

import { and, eq, isNull } from "drizzle-orm";
import pino from "pino";

import {
  capabilityRefIdSetsFromRecords,
  firstUnknownCapabilityRef,
  firstUnknownPackageMcpRef,
  type CapabilityRefRecord,
} from "@/lib/config";
import {
  resolveCompiledStepTargetRunnerId,
  type FlowRunnerRemapRow,
} from "@/lib/acp-runners/flow-step-target";
import {
  resolveRunner,
  type RunnerCatalogEntry,
} from "@/lib/acp-runners/resolve";
import {
  copyBundleArtifactsToWorktree,
  ensureWorktreeGitignore,
  writeAiFactoryConfigOverride,
} from "@/lib/capabilities/materialize-bundle";
import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import {
  assertNodeLaunchable,
  capabilityBearingSettings,
} from "@/lib/flows/enforcement";
import {
  isEngineCompatible,
  isSchemaVersionSupported,
} from "@/lib/flows/engine-version";
import {
  buildResolvedCapabilitySet,
  firstAgentUnsupportedRequiredMcp,
} from "@/lib/capabilities/resolver";
import { normalizeNodeMcps } from "@/lib/config.schema";
import { compileManifest } from "@/lib/flows/graph/compile";
import { resolveEffectiveFlowRevision } from "@/lib/flows/lifecycle";
import { runFlow } from "@/lib/flows/runner";
import { worktreesRoot } from "@/lib/instance-config";
import {
  classifyTaskLaunchability,
  getLatestFlowRun,
} from "@/lib/runs/launchability";
import { tryStartRun } from "@/lib/scheduler";
import { checkSupervisorHealth } from "@/lib/supervisor-client";
import {
  addWorktree,
  listBranches,
  removeWorktree,
  resolveBaseCommit,
} from "@/lib/worktree";

// FIXME(any): dual drizzle-orm peer-dep variants.
const {
  capabilityImports,
  capabilityRecords,
  flowRevisions,
  flowRunnerRemaps,
  flows,
  platformAcpRunners,
  platformRouterSidecars,
  platformRuntimeSettings,
  projectFlowRunnerDefaults,
  projectFlowRoles,
  projects,
  runs,
  tasks,
  workspaces,
} = schemaModule as unknown as Record<string, any>;

// M13: a launch is refused (CONFIG → 400) when any compiled node's
// finish.human.role or settings.roles references a Flow role not in the
// project's active (non-archived) project_flow_roles registry. An empty
// registry skips the check (no roles configured yet).
function assertCompiledFlowRolesLaunchable(args: {
  compiled: ReturnType<typeof compileManifest>;
  activeRoleRefs: ReadonlySet<string>;
  flowRefId: string;
  projectSlug: string;
}): void {
  if (args.activeRoleRefs.size === 0) return;

  for (const node of args.compiled.nodes.values()) {
    const finishRole = node.finishHuman?.role;

    if (finishRole !== undefined && !args.activeRoleRefs.has(finishRole)) {
      throw new MaisterError(
        "CONFIG",
        `flow "${args.flowRefId}" node "${node.id}" finish.human.role references unknown active Flow role "${finishRole}" for project ${args.projectSlug}`,
      );
    }

    if (
      node.source.kind !== "node" ||
      (node.source.node.type !== "human" && node.source.node.type !== "form")
    ) {
      continue;
    }

    for (const role of node.source.node.settings?.roles ?? []) {
      if (args.activeRoleRefs.has(role)) continue;

      throw new MaisterError(
        "CONFIG",
        `flow "${args.flowRefId}" node "${node.id}" settings.roles references unknown active Flow role "${role}" for project ${args.projectSlug}`,
      );
    }
  }
}

// FIXME(any): dual drizzle-orm peer-dep variants.
type Db = any;

const log = pino({
  name: "service-runs",
  level: process.env.LOG_LEVEL ?? "info",
});

// Explicit allow-list of project flow enablement states that may launch a run
// (M10, ADR-021). `Installed`/`Disabled`/`Failed`/`Deprecated` are NOT
// launchable — enablement is an explicit action separate from trust.
const LAUNCHABLE_ENABLEMENT_STATES = new Set<string>([
  "Enabled",
  "UpdateAvailable",
]);

export type LaunchRunInput = {
  taskId: string;
  runnerId?: string;
  baseBranch?: string;
  targetBranch?: string;
};

export type PromotionMode = "local_merge" | "pull_request";

// M18 §3.4: resolve the per-run promotion mode from the override chain. The
// `local_merge` default is folded HERE (not as a per-key zod default), so a
// CLEARed project value (null) resolves back to the default. Only the two
// valid enum members are accepted; any other value falls through to the
// default rather than being persisted as-is.
export function resolvePromotionMode(args: {
  launchOverride?: string | null;
  projectPromotionMode?: string | null;
}): PromotionMode {
  const candidate = args.launchOverride ?? args.projectPromotionMode;

  if (candidate === "local_merge" || candidate === "pull_request") {
    return candidate;
  }

  return "local_merge";
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

function runnerCatalogEntry(
  row: Record<string, any>,
  sidecarById: ReadonlyMap<string, Record<string, any>>,
): RunnerCatalogEntry {
  const sidecar = row.sidecarId ? sidecarById.get(row.sidecarId) : undefined;

  return {
    id: row.id,
    adapter: row.adapter,
    capabilityAgent: row.capabilityAgent,
    model: row.model,
    provider: row.provider,
    providerKind: runnerProviderKind(row.provider),
    permissionPolicy: row.permissionPolicy,
    sidecar: sidecar
      ? {
          id: sidecar.id,
          kind: sidecar.kind,
          lifecycle: sidecar.lifecycle,
          configPath: sidecar.configPath,
          baseUrl: sidecar.baseUrl,
          healthcheckUrl: sidecar.healthcheckUrl,
          authTokenRef: sidecar.authTokenRef,
        }
      : null,
    sidecarId: row.sidecarId,
    enabled: row.enabled,
    ready: row.readinessStatus === "Ready",
  };
}

export type LaunchRunContext = {
  actorUserId?: string | null;
  authorize: (projectId: string) => Promise<void>;
  recordSuccessAudit?: (db: Db) => Promise<void>;
};

export async function launchRun(
  input: LaunchRunInput,
  ctx: LaunchRunContext,
  db?: Db,
): Promise<{ runId: string; status: string; queuePosition?: number }> {
  // FIXME(any): dual drizzle-orm peer-dep variants — pg|sqlite union.
  const _db = (db ?? getDb()) as unknown as {
    select: any;
    insert: any;
    update: any;
    transaction: any;
  };

  const taskRows = await _db
    .select()
    .from(tasks)
    .where(eq(tasks.id, input.taskId));
  const task = taskRows[0];

  if (!task) {
    throw new MaisterError("PRECONDITION", `task not found: ${input.taskId}`);
  }
  // tasks.status is a one-way latch (nothing writes Backlog back after
  // launch), so the latest flow run — not the task row — decides
  // relaunchability (board retry rule, attempt N+1).
  const latestFlowRun = await getLatestFlowRun(input.taskId, _db);
  const launchability = classifyTaskLaunchability(task, latestFlowRun);

  if (launchability !== "launchable") {
    throw new MaisterError(
      "PRECONDITION",
      `task is not launchable (classification: ${launchability})`,
    );
  }
  log.debug(
    { taskId: input.taskId, classification: launchability },
    "launch gate",
  );

  const projectRows = await _db
    .select()
    .from(projects)
    .where(eq(projects.id, task.projectId));
  const project = projectRows[0];

  if (!project) {
    throw new MaisterError("PRECONDITION", "project not found for task");
  }
  if (project.archivedAt) {
    throw new MaisterError("PRECONDITION", "project is archived");
  }

  // AuthzError from ctx.authorize propagates untouched.
  await ctx.authorize(project.id);

  const flowRows = await _db
    .select()
    .from(flows)
    .where(eq(flows.id, task.flowId));
  const flow = flowRows[0];

  if (!flow) {
    throw new MaisterError("PRECONDITION", "flow not found for task");
  }

  // Resolve the project-enabled package revision (M10, ADR-021) and refuse
  // launch on a package that is not in an explicitly launchable state, or is
  // untrusted/incompatible/missing-setup — BEFORE any workspace creation. The
  // revision is server-derived from the enablement pointer, never
  // body-controlled.
  //
  // Launchability is an explicit allow-list (LAUNCHABLE_ENABLEMENT_STATES):
  // only `Enabled` and `UpdateAvailable` (which still has a live enabled
  // revision) may launch. `Installed` is NOT launchable — a package installed
  // from an untrusted source stays `Installed` after `/trust` and must be
  // explicitly `/enable`d before it can run. This prevents trust alone from
  // collapsing the trust+enable lifecycle into one launchable step.
  if (!flow.enabledRevisionId) {
    throw new MaisterError(
      "PRECONDITION",
      `flow "${flow.flowRefId}" has no enabled package revision`,
    );
  }
  if (!LAUNCHABLE_ENABLEMENT_STATES.has(flow.enablementState)) {
    throw new MaisterError(
      "PRECONDITION",
      `flow "${flow.flowRefId}" package is ${flow.enablementState}, not launchable (enable it first)`,
    );
  }
  if (flow.trustStatus === "untrusted") {
    throw new MaisterError(
      "PRECONDITION",
      `flow "${flow.flowRefId}" package is not trusted — confirm trust before launch`,
    );
  }

  // M27/T-B4: resolve the effective revision per flows.version_binding (ADR-069).
  // `pinned` = the enabled pointer (unchanged behavior); `latest` = the newest
  // Installed revision for this flow_ref_id (a just-published authored revision
  // floats in via the bridge). The per-revision guards below still gate the
  // RESOLVED revision (packageStatus/setupStatus/engine/schema).
  const effectiveRevisionId =
    (await resolveEffectiveFlowRevision(_db, flow)) ?? flow.enabledRevisionId;

  const revisionRows = await _db
    .select()
    .from(flowRevisions)
    .where(eq(flowRevisions.id, effectiveRevisionId));
  const revision = revisionRows[0];

  if (!revision) {
    throw new MaisterError(
      "PRECONDITION",
      `enabled revision not found for flow "${flow.flowRefId}"`,
    );
  }
  // Refuse a broken enabled pointer: a revision that was removed (or failed)
  // out from under the enablement pointer must not reach runner startup
  // (Codex finding #2 — concurrent removeRevision vs enable).
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
  {
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

  const compiled = compileManifest(revision.manifest as FlowYamlV1);
  const runtimeRows = await _db
    .select()
    .from(platformRuntimeSettings)
    .where(eq(platformRuntimeSettings.id, "singleton"));
  const platformRuntime = runtimeRows[0];

  if (!platformRuntime) {
    throw new MaisterError(
      "EXECUTOR_UNAVAILABLE",
      "platform default ACP runner is not configured",
    );
  }

  const runnerRows = await _db.select().from(platformAcpRunners);
  const sidecarRows = await _db.select().from(platformRouterSidecars);
  const sidecarById = new Map<string, Record<string, any>>(
    sidecarRows.map((row: Record<string, any>) => [row.id, row]),
  );
  const runnerCatalog = runnerRows.map((row: Record<string, any>) =>
    runnerCatalogEntry(row, sidecarById),
  );

  const projectFlowDefaultRows = await _db
    .select({ runnerId: projectFlowRunnerDefaults.runnerId })
    .from(projectFlowRunnerDefaults)
    .where(
      and(
        eq(projectFlowRunnerDefaults.projectId, project.id),
        eq(projectFlowRunnerDefaults.flowId, flow.id),
      ),
    );
  const projectFlowDefaultRunnerId =
    projectFlowDefaultRows[0]?.runnerId ?? null;
  const remapRows: FlowRunnerRemapRow[] = await _db
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
    );
  const stepTargetRunnerId = resolveCompiledStepTargetRunnerId({
    compiled,
    remaps: remapRows,
    flowRefId: flow.flowRefId,
  });
  const runnerResolution = resolveRunner({
    launchOverrideRunnerId: input.runnerId,
    step: { runnerId: stepTargetRunnerId },
    projectFlow: { defaultRunnerId: projectFlowDefaultRunnerId },
    platformFlow: { defaultRunnerId: revision.defaultRunnerId },
    project: { defaultRunnerId: project.defaultRunnerId },
    platform: { defaultRunnerId: platformRuntime.defaultRunnerId },
    runners: runnerCatalog,
  });
  const capabilityAgent = runnerResolution.capabilityAgent as CapabilityAgent;

  const platformStatus = await checkSupervisorHealth();

  if (platformStatus.kind === "unavailable") {
    log.warn(
      {
        taskId: task.id,
        projectId: project.id,
        runnerId: runnerResolution.runnerId,
        runnerResolutionTier: runnerResolution.runnerResolutionTier,
        reason: platformStatus.reason,
        message: platformStatus.message,
      },
      "POST /api/runs supervisor readiness unavailable",
    );
    throw new MaisterError(
      "EXECUTOR_UNAVAILABLE",
      `supervisor unavailable (${platformStatus.reason}): ${platformStatus.message}`,
    );
  }

  // M11c (ADR-032): static settings-enforcement gate. Refuse the launch
  // BEFORE any worktree/run/workspace side-effect when any capability-bearing
  // (ai_coding/judge) node in the pinned manifest declares a `strict`
  // enforcement intent the resolved runner's agent cannot honor. The throw
  // propagates to errorResponse → httpStatusForCode: CONFIG→400 (the build
  // cannot enforce the class), EXECUTOR_UNAVAILABLE→503 (another agent could)
  // — the FROZEN SPEC mapping (docs/system-analytics/flow-settings.md §launch
  // -refusal). No worktree/run/workspace is created (we are before addWorktree).
  {
    // M13: active Flow-role registry (non-archived project_flow_roles).
    const projectRoleRows = await _db
      .select({ ref: projectFlowRoles.roleRef })
      .from(projectFlowRoles)
      .where(
        and(
          eq(projectFlowRoles.projectId, project.id),
          isNull(projectFlowRoles.archivedAt),
        ),
      );
    const activeFlowRoleRefs = new Set<string>(
      projectRoleRows.map((r: { ref: string }) => r.ref),
    );

    const skippedFlowRoleValidation = activeFlowRoleRefs.size === 0;

    assertCompiledFlowRolesLaunchable({
      compiled,
      activeRoleRefs: activeFlowRoleRefs,
      flowRefId: flow.flowRefId,
      projectSlug: project.slug,
    });

    // M14 carve-b: capability ref registry from the hydrated capability_records
    // catalog (DB mirror; maister.yaml is NOT re-read). Only non-disabled rows
    // count, so a CLEARed capability no longer resolves.
    const capRecordRows: CapabilityRefRecord[] = await _db
      .select({
        capabilityRefId: capabilityRecords.capabilityRefId,
        kind: capabilityRecords.kind,
        source: capabilityRecords.source,
      })
      .from(capabilityRecords)
      .where(
        and(
          eq(capabilityRecords.projectId, project.id),
          isNull(capabilityRecords.disabledAt),
        ),
      );
    const capabilityRefIds = capabilityRefIdSetsFromRecords(capRecordRows);

    let configuredNodes = 0;
    // M27/T-C8b: REQUIRED mcp refs (node settings.mcps.required ∪ package-level)
    // gathered for the agent-support refusal after the loop.
    const requiredMcpRefs = new Set<string>();

    for (const node of compiled.nodes.values()) {
      if (node.nodeType !== "ai_coding" && node.nodeType !== "judge") {
        continue;
      }
      configuredNodes += 1;

      const settings = capabilityBearingSettings(node.nodeType, node.settings);

      for (const ref of normalizeNodeMcps(settings?.mcps).required) {
        requiredMcpRefs.add(ref);
      }

      // M14 carve-b: reject node settings.mcps/skills/restrictions/
      // settingsProfile refs absent from the project capability registry.
      const unknownCapability = firstUnknownCapabilityRef(
        node.nodeType,
        settings,
        capabilityRefIds,
      );

      if (unknownCapability !== null) {
        throw new MaisterError(
          "CONFIG",
          `node "${node.id}" unknown ${unknownCapability.kind} capability ref "${unknownCapability.ref}" not registered for project ${project.slug}`,
        );
      }

      assertNodeLaunchable(
        { id: node.id, nodeType: node.nodeType, settings },
        capabilityAgent,
      );
    }

    // M27/T-C6 (C6-top, ADR-070): reject package-level required MCP refs
    // (manifest top-level `mcps`) absent from the project registry — after the
    // per-node M14 cap-ref check, before any side-effect. The
    // known-but-unmaterializable required-MCP refusal is T-C8.
    const unknownPackageMcp = firstUnknownPackageMcpRef(
      (revision.manifest as FlowYamlV1).mcps,
      capabilityRefIds.mcp,
    );

    if (unknownPackageMcp !== null) {
      throw new MaisterError(
        "CONFIG",
        `flow "${flow.flowRefId}" declares unknown required mcp capability ref "${unknownPackageMcp}" not registered for project ${project.slug}`,
      );
    }

    for (const ref of (revision.manifest as FlowYamlV1).mcps ?? []) {
      requiredMcpRefs.add(ref);
    }

    // M27/T-C8b (mcp-management §6.2, bullet 6): a REQUIRED mcp whose resolved
    // winner record does not support the executor agent cannot materialize →
    // refuse launch (EXECUTOR_UNAVAILABLE → 503), before any side-effect.
    // ADDITIONAL mcps degrade gracefully at materialization (non-fatal).
    if (requiredMcpRefs.size > 0) {
      const mcpAgentRows = await _db
        .select({
          capabilityRefId: capabilityRecords.capabilityRefId,
          source: capabilityRecords.source,
          agents: capabilityRecords.agents,
        })
        .from(capabilityRecords)
        .where(
          and(
            eq(capabilityRecords.projectId, project.id),
            eq(capabilityRecords.kind, "mcp"),
            isNull(capabilityRecords.disabledAt),
          ),
        );

      const unsupportedMcp = firstAgentUnsupportedRequiredMcp(
        [...requiredMcpRefs],
        mcpAgentRows,
        capabilityAgent,
      );

      if (unsupportedMcp !== null) {
        throw new MaisterError(
          "EXECUTOR_UNAVAILABLE",
          `required mcp "${unsupportedMcp}" cannot materialize for executor agent ${capabilityAgent} in project ${project.slug}`,
        );
      }
    }

    log.info(
      {
        taskId: task.id,
        flowRefId: flow.flowRefId,
        runnerId: runnerResolution.runnerId,
        runnerResolutionTier: runnerResolution.runnerResolutionTier,
        capabilityAgent,
        capabilityNodes: configuredNodes,
        platformRunners: runnerCatalog.length,
        projectFlowRoles: activeFlowRoleRefs.size,
        skippedFlowRoleValidation,
      },
      skippedFlowRoleValidation
        ? "[FIX:M13] POST /api/runs settings-enforcement gate passed with empty Flow role registry"
        : "POST /api/runs settings-enforcement gate passed",
    );
  }

  const newAttempt = task.attemptNumber + 1;
  const branch = `${project.branchPrefix}task-${task.id}/attempt-${newAttempt}`;
  const worktreeRoot = worktreesRoot();
  const runId = randomUUID();
  const worktreePath = path.join(worktreeRoot, project.slug, runId);

  // M18 §3.1: branch targeting. base defaults to the project default branch;
  // target defaults to the resolved base. BOTH are body-controlled, so they
  // MUST be validated against the project's real branch set (server-state
  // allow-list) BEFORE any git side-effect — an unknown branch is a
  // PRECONDITION refusal and no worktree is created.
  const base = input.baseBranch ?? project.mainBranch;
  const target = input.targetBranch ?? base;
  const knownBranches = new Set(await listBranches(project.repoPath));

  if (!knownBranches.has(base)) {
    throw new MaisterError(
      "PRECONDITION",
      `base branch "${base}" does not exist in ${project.slug}`,
    );
  }
  if (!knownBranches.has(target)) {
    throw new MaisterError(
      "PRECONDITION",
      `target branch "${target}" does not exist in ${project.slug}`,
    );
  }

  const baseCommit = await resolveBaseCommit({
    projectRepoPath: project.repoPath,
    baseRef: base,
  });
  const promotionMode = resolvePromotionMode({
    projectPromotionMode: project.promotionMode,
  });

  log.info(
    {
      taskId: task.id,
      runId,
      createdByUserId: ctx.actorUserId,
      runnerId: runnerResolution.runnerId,
      runnerResolutionTier: runnerResolution.runnerResolutionTier,
      capabilityAgent,
      branch,
      worktreePath,
    },
    "POST /api/runs preconditions ok",
  );
  log.debug(
    { runId, base, target, baseCommit, promotionMode },
    "POST /api/runs branch targeting resolved",
  );

  // Create the worktree BEFORE the DB transaction so a git failure
  // (branch already exists, dirty parent repo, missing path) does
  // NOT leave the task stuck in InFlight with an orphan run/workspace
  // row. The task stays in Backlog and is launchable again. The worktree
  // forks from the resolved base commit (M18 startPoint), not parent HEAD.
  await addWorktree({
    projectRepoPath: project.repoPath,
    branch,
    worktreePath,
    startPoint: baseCommit,
  });

  // M27/T-C8 (§7.1.8): freeze the resolved capability set onto the run so an
  // edit/publish mid-run cannot mutate it. flowOrigin: authored installs use a
  // local filesystem source (the bridge temp dir); git installs use a remote ref.
  const snapshotRecords = (await _db
    .select({
      capabilityRefId: capabilityRecords.capabilityRefId,
      kind: capabilityRecords.kind,
      source: capabilityRecords.source,
      revision: capabilityRecords.revision,
    })
    .from(capabilityRecords)
    .where(
      and(
        eq(capabilityRecords.projectId, project.id),
        isNull(capabilityRecords.disabledAt),
      ),
    )) as Array<{
    capabilityRefId: string;
    kind: string;
    source: string;
    revision: string | null;
  }>;
  const resolvedCapabilitySet = buildResolvedCapabilitySet({
    records: snapshotRecords,
    flowRevisionId: revision.id,
    flowOrigin: revision.source?.startsWith("/") ? "authored" : "git",
  });

  log.debug(
    {
      runId,
      flowRevisionId: revision.id,
      flowOrigin: resolvedCapabilitySet.flowOrigin,
      capabilityCount: resolvedCapabilitySet.capabilities.length,
      mcpCount: resolvedCapabilitySet.mcps.length,
    },
    "[service.runs] resolved capability set snapshot built",
  );

  try {
    // Deliver AIF capability bundles into the fresh worktree's .claude/ and
    // write the per-run .ai-factory/config.yaml git-ownership override. Gated
    // on >=1 Installed import so non-AIF projects never get a stray config.
    // A failure here lands in the catch below → worktree compensation + abort.
    const installedImports = await _db
      .select({ installedPath: capabilityImports.installedPath })
      .from(capabilityImports)
      .where(
        and(
          eq(capabilityImports.projectId, project.id),
          eq(capabilityImports.packageStatus, "Installed"),
        ),
      );

    if (installedImports.length > 0) {
      for (const imp of installedImports) {
        await copyBundleArtifactsToWorktree({
          installedPath: imp.installedPath,
          worktreePath,
        });
      }
      await writeAiFactoryConfigOverride({ worktreePath, baseBranch: base });
      await ensureWorktreeGitignore(worktreePath);
      log.info(
        {
          runId,
          worktreePath,
          bundles: installedImports.length,
          baseBranch: base,
        },
        "[capabilities] materialized capability bundles + AIF config override into worktree",
      );
    }

    await _db.transaction(async (tx: any) => {
      // `runs` first: `workspaces.run_id` is a non-deferrable FK to `runs.id`,
      // so the workspace insert would violate it if it ran first.
      await tx.insert(runs).values({
        id: runId,
        taskId: task.id,
        projectId: project.id,
        flowId: flow.id,
        runnerId: runnerResolution.runnerId,
        runnerResolutionTier: runnerResolution.runnerResolutionTier,
        capabilityAgent,
        runnerSnapshot: runnerResolution.runnerSnapshot,
        resolvedCapabilitySet,
        createdByUserId: ctx.actorUserId,
        status: "Pending",
        // Snapshot the enabled revision (M10, ADR-021). flow_revision_id is
        // the authoritative pin the runner resolves the manifest + bundle
        // path from; the version/SHA text columns remain for display and the
        // legacy fallback. A later upgrade/rollback changes the project's
        // enabled revision but this run stays pinned to what it launched with.
        flowVersion: revision.versionLabel,
        flowRevision: revision.resolvedRevision,
        flowRevisionId: revision.id,
      });
      await tx.insert(workspaces).values({
        id: randomUUID(),
        runId,
        projectId: project.id,
        branch,
        worktreePath,
        parentRepoPath: project.repoPath,
        baseBranch: base,
        baseCommit,
        targetBranch: target,
        promotionMode,
      });
      await tx
        .update(tasks)
        .set({
          status: "InFlight",
          attemptNumber: newAttempt,
          updatedAt: new Date(),
        })
        .where(eq(tasks.id, task.id));

      await ctx.recordSuccessAudit?.(tx);
    });
  } catch (err) {
    // DB transaction rolled back. Compensate: remove the orphan worktree
    // so the next launch can recreate the same branch+path without a
    // PRECONDITION "already exists" failure.
    log.warn(
      { runId, err: (err as Error).message },
      "launch setup failed after addWorktree — removing worktree",
    );
    await removeWorktree({
      projectRepoPath: project.repoPath,
      worktreePath,
      force: true,
    }).catch((rmErr) =>
      log.error(
        { rmErr: (rmErr as Error).message, worktreePath },
        "compensating removeWorktree failed (manual cleanup may be required)",
      ),
    );
    throw err;
  }

  const startResult = await tryStartRun(runId, { db: _db });

  if (startResult.started) {
    void runFlow(runId).catch((err: unknown) =>
      log.error(
        { err: (err as Error).message, runId },
        "background runFlow failed",
      ),
    );

    return { runId, status: "Running" };
  }

  return { runId, status: "Pending", queuePosition: startResult.queuePosition };
}

export type RunDTO = {
  id: string;
  taskId: string | null;
  projectId: string;
  status: string;
  flowId: string | null;
  runnerId: string;
  currentStepId: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
};

export async function getRunDTO(
  runId: string,
  projectId: string,
  db?: Db,
): Promise<RunDTO | null> {
  const _db = (db ?? getDb()) as unknown as { select: any };
  const rows = await (_db as any)
    .select({
      id: runs.id,
      taskId: runs.taskId,
      projectId: runs.projectId,
      status: runs.status,
      flowId: runs.flowId,
      runnerId: runs.runnerId,
      currentStepId: runs.currentStepId,
      startedAt: runs.startedAt,
      finishedAt: runs.endedAt,
    })
    .from(runs)
    .where(and(eq(runs.id, runId), eq(runs.projectId, projectId)));

  if (rows.length === 0) return null;

  const row = rows[0];

  return {
    id: row.id,
    taskId: row.taskId ?? null,
    projectId: row.projectId,
    status: row.status,
    flowId: row.flowId ?? null,
    runnerId: row.runnerId,
    currentStepId: row.currentStepId ?? null,
    startedAt: row.startedAt ?? null,
    finishedAt: row.finishedAt ?? null,
  };
}
