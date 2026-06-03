import "server-only";

import type { AiCodingSettings, FlowYamlV1 } from "@/lib/config.schema";

import { randomUUID } from "node:crypto";
import path from "node:path";

import { and, eq, isNull } from "drizzle-orm";
import pino from "pino";

import {
  capabilityRefIdSetsFromRecords,
  firstUnknownExecutorRef,
  firstUnknownCapabilityRef,
  type CapabilityRefRecord,
} from "@/lib/config";
import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { resolveExecutor } from "@/lib/executors";
import {
  assertNodeLaunchable,
  capabilityBearingSettings,
} from "@/lib/flows/enforcement";
import {
  isEngineCompatible,
  isSchemaVersionSupported,
} from "@/lib/flows/engine-version";
import { compileManifest } from "@/lib/flows/graph/compile";
import { runFlow } from "@/lib/flows/runner";
import { worktreesRoot } from "@/lib/instance-config";
import { tryStartRun } from "@/lib/scheduler";
import { checkSupervisorHealth } from "@/lib/supervisor-client";
import { addWorktree, removeWorktree } from "@/lib/worktree";

// FIXME(any): dual drizzle-orm peer-dep variants.
const {
  capabilityRecords,
  executors,
  flowRevisions,
  flows,
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

    if (node.source.kind !== "node" || node.source.node.type !== "human") {
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
  executorOverrideId?: string;
};

export type LaunchRunContext = {
  actorUserId?: string | null;
  authorize: (projectId: string) => Promise<void>;
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
  if (task.status !== "Backlog") {
    throw new MaisterError(
      "PRECONDITION",
      `task is not in Backlog (got ${task.status})`,
    );
  }

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

  const revisionRows = await _db
    .select()
    .from(flowRevisions)
    .where(eq(flowRevisions.id, flow.enabledRevisionId));
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

  const { executorId, tier: resolvedFromTier } = resolveExecutor({
    override: input.executorOverrideId,
    task,
    project,
    flow,
  });

  const executorRows = await _db
    .select()
    .from(executors)
    .where(
      and(eq(executors.id, executorId), eq(executors.projectId, project.id)),
    );
  const executor = executorRows[0];

  if (!executor) {
    throw new MaisterError(
      "EXECUTOR_UNAVAILABLE",
      `executor ${executorId} not registered for project ${project.slug}`,
    );
  }

  const platformStatus = await checkSupervisorHealth();

  if (platformStatus.kind === "unavailable") {
    log.warn(
      {
        taskId: task.id,
        projectId: project.id,
        executorId: executor.id,
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
  // enforcement intent the resolved executor's agent cannot honor. The throw
  // propagates to errorResponse → httpStatusForCode: CONFIG→400 (the build
  // cannot enforce the class), EXECUTOR_UNAVAILABLE→503 (another agent could)
  // — the FROZEN SPEC mapping (docs/system-analytics/flow-settings.md §launch
  // -refusal). No worktree/run/workspace is created (we are before addWorktree).
  {
    // Project executor *ref* id set (maister.yaml executor ids) for the
    // node-level settings.executors[] cross-reference (AC-4). Resolved here
    // because a flow package is generic across projects — the refs only have
    // meaning against a concrete project's executors[]. Distinct id space from
    // executors.id (the DB PK resolveExecutor returns).
    const projectExecutorRows = await _db
      .select({ refId: executors.executorRefId })
      .from(executors)
      .where(eq(executors.projectId, project.id));
    const executorRefIds = new Set<string>(
      projectExecutorRows.map((r: { refId: string }) => r.refId),
    );

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

    const compiled = compileManifest(revision.manifest as FlowYamlV1);
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

    for (const node of compiled.nodes.values()) {
      if (node.nodeType !== "ai_coding" && node.nodeType !== "judge") {
        continue;
      }
      configuredNodes += 1;

      const settings = capabilityBearingSettings(node.nodeType, node.settings);

      // settings.executors exists only on ai_coding; reject any ref absent
      // from the project's executors[] before any side-effect (CONFIG → 400).
      if (node.nodeType === "ai_coding") {
        const unknownRef = firstUnknownExecutorRef(
          (settings as AiCodingSettings | undefined)?.executors,
          executorRefIds,
        );

        if (unknownRef !== null) {
          throw new MaisterError(
            "CONFIG",
            `node "${node.id}" settings.executors references unknown executor id "${unknownRef}" not registered for project ${project.slug}`,
          );
        }
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
        executor.agent,
      );
    }

    log.info(
      {
        taskId: task.id,
        flowRefId: flow.flowRefId,
        executorId: executor.id,
        agent: executor.agent,
        capabilityNodes: configuredNodes,
        projectExecutors: executorRefIds.size,
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

  log.info(
    {
      taskId: task.id,
      runId,
      createdByUserId: ctx.actorUserId,
      executorId: executor.id,
      resolvedFromTier,
      branch,
      worktreePath,
    },
    "POST /api/runs preconditions ok",
  );

  // Create the worktree BEFORE the DB transaction so a git failure
  // (branch already exists, dirty parent repo, missing path) does
  // NOT leave the task stuck in InFlight with an orphan run/workspace
  // row. The task stays in Backlog and is launchable again.
  await addWorktree({
    projectRepoPath: project.repoPath,
    branch,
    worktreePath,
  });

  try {
    await _db.transaction(async (tx: any) => {
      // `runs` first: `workspaces.run_id` is a non-deferrable FK to `runs.id`,
      // so the workspace insert would violate it if it ran first.
      await tx.insert(runs).values({
        id: runId,
        taskId: task.id,
        projectId: project.id,
        flowId: flow.id,
        executorId: executor.id,
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
      });
      await tx
        .update(tasks)
        .set({
          status: "InFlight",
          attemptNumber: newAttempt,
          updatedAt: new Date(),
        })
        .where(eq(tasks.id, task.id));
    });
  } catch (err) {
    // DB transaction rolled back. Compensate: remove the orphan worktree
    // so the next launch can recreate the same branch+path without a
    // PRECONDITION "already exists" failure.
    log.warn(
      { runId, err: (err as Error).message },
      "DB transaction failed after addWorktree — removing worktree",
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
  executorId: string;
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
      executorId: runs.executorId,
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
    executorId: row.executorId,
    currentStepId: row.currentStepId ?? null,
    startedAt: row.startedAt ?? null,
    finishedAt: row.finishedAt ?? null,
  };
}
