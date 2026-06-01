import "server-only";

import type { AiCodingSettings, FlowYamlV1 } from "@/lib/config.schema";

import { randomUUID } from "node:crypto";
import path from "node:path";

import { and, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import pino from "pino";
import { z } from "zod";

import { requireActiveSession, requireProjectAction } from "@/lib/authz";
import { firstUnknownExecutorRef } from "@/lib/config";
import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { isMaisterError, MaisterError } from "@/lib/errors";
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
const { executors, flowRevisions, flows, projects, runs, tasks, workspaces } =
  schemaModule as unknown as Record<string, any>;

const log = pino({
  name: "api-runs",
  level: process.env.LOG_LEVEL ?? "info",
});

const postBodySchema = z.object({
  taskId: z.string().min(1),
  executorOverrideId: z.string().min(1).optional(),
});

// Explicit allow-list of project flow enablement states that may launch a run
// (M10, ADR-021). `Installed`/`Disabled`/`Failed`/`Deprecated` are NOT
// launchable — enablement is an explicit action separate from trust.
const LAUNCHABLE_ENABLEMENT_STATES = new Set<string>([
  "Enabled",
  "UpdateAvailable",
]);

function errorResponse(err: unknown): NextResponse {
  if (isMaisterError(err)) {
    const status = httpStatusForCode(err.code);

    return NextResponse.json(
      { code: err.code, message: err.message },
      { status },
    );
  }
  const message = err instanceof Error ? err.message : String(err);

  log.error({ err: message }, "POST /api/runs unhandled error");

  return NextResponse.json(
    { code: "CRASH", message: "internal error" },
    { status: 500 },
  );
}

function httpStatusForCode(code: string): number {
  switch (code) {
    case "UNAUTHENTICATED":
      return 401;
    case "UNAUTHORIZED":
    case "PASSWORD_CHANGE_REQUIRED":
      return 403;
    case "PRECONDITION":
    case "CONFLICT":
      return 409;
    case "EXECUTOR_UNAVAILABLE":
      return 503;
    case "CONFIG":
      return 400;
    default:
      return 500;
  }
}

function resolveWorktreeRoot(): string {
  return worktreesRoot();
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: z.infer<typeof postBodySchema>;

  try {
    body = postBodySchema.parse(await req.json());
  } catch (err) {
    return errorResponse(
      new MaisterError(
        "CONFIG",
        `invalid POST body: ${(err as Error).message}`,
      ),
    );
  }

  try {
    // Auth-first: authenticate AND clear the forced-password-change gate up
    // front, so must-change callers cannot probe task/project existence before
    // auth. Project-role authz happens once projectId is derived from the task
    // row below (taskId is body-controlled — never trust a body projectId).
    const user = await requireActiveSession();

    // FIXME(any): dual drizzle-orm peer-dep variants — pg|sqlite union.
    const db = getDb() as unknown as {
      select: any;
      insert: any;
      update: any;
      transaction: any;
    };

    const taskRows = await db
      .select()
      .from(tasks)
      .where(eq(tasks.id, body.taskId));
    const task = taskRows[0];

    if (!task) {
      throw new MaisterError("PRECONDITION", `task not found: ${body.taskId}`);
    }
    if (task.status !== "Backlog") {
      throw new MaisterError(
        "PRECONDITION",
        `task is not in Backlog (got ${task.status})`,
      );
    }

    const projectRows = await db
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

    await requireProjectAction(project.id, "launchRun");

    const flowRows = await db
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

    const revisionRows = await db
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
    if (
      revision.setupStatus === "pending" ||
      revision.setupStatus === "failed"
    ) {
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
      override: body.executorOverrideId,
      task,
      project,
      flow,
    });

    const executorRows = await db
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
      const projectExecutorRows = await db
        .select({ refId: executors.executorRefId })
        .from(executors)
        .where(eq(executors.projectId, project.id));
      const executorRefIds = new Set<string>(
        projectExecutorRows.map((r: { refId: string }) => r.refId),
      );

      const compiled = compileManifest(revision.manifest as FlowYamlV1);
      let configuredNodes = 0;

      for (const node of compiled.nodes.values()) {
        if (node.nodeType !== "ai_coding" && node.nodeType !== "judge") {
          continue;
        }
        configuredNodes += 1;

        const settings = capabilityBearingSettings(
          node.nodeType,
          node.settings,
        );

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
        },
        "POST /api/runs settings-enforcement gate passed",
      );
    }

    const newAttempt = task.attemptNumber + 1;
    const branch = `${project.branchPrefix}task-${task.id}/attempt-${newAttempt}`;
    const worktreeRoot = resolveWorktreeRoot();
    const runId = randomUUID();
    const worktreePath = path.join(worktreeRoot, project.slug, runId);

    log.info(
      {
        taskId: task.id,
        runId,
        createdByUserId: user.id,
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
      await db.transaction(async (tx: any) => {
        // `runs` first: `workspaces.run_id` is a non-deferrable FK to `runs.id`,
        // so the workspace insert would violate it if it ran first.
        await tx.insert(runs).values({
          id: runId,
          taskId: task.id,
          projectId: project.id,
          flowId: flow.id,
          executorId: executor.id,
          createdByUserId: user.id,
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

    const startResult = await tryStartRun(runId, { db });

    if (startResult.started) {
      void runFlow(runId).catch((err: unknown) =>
        log.error(
          { err: (err as Error).message, runId },
          "background runFlow failed",
        ),
      );

      return NextResponse.json({ runId, status: "Running" }, { status: 202 });
    }

    return NextResponse.json(
      { runId, status: "Pending", queuePosition: startResult.queuePosition },
      { status: 202 },
    );
  } catch (err) {
    return errorResponse(err);
  }
}
