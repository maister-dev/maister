import "server-only";

import type {
  Flow as FlowRow,
  PlatformAcpRunner,
  Run as RunRow,
  RunnerSnapshot,
  Task as TaskRow,
  Workspace as WorkspaceRow,
} from "@/lib/db/schema";
import type { FlowYamlV1 } from "@/lib/config.schema";
import type { AcpSessionState } from "../types";
import type { SupervisorApi } from "../runner-agent";

import { eq } from "drizzle-orm";
import pino from "pino";

import { deleteSession as defaultDeleteSession } from "@/lib/supervisor-client";
import { MaisterError } from "@/lib/errors";
import * as schemaModule from "@/lib/db/schema";
import { systemCachePath } from "@/lib/flow-paths";

// FIXME(any): dual drizzle-orm peer-dep variants.
const {
  flowRevisions,
  flows,
  platformAcpRunners,
  projects,
  runs,
  tasks,
  workspaces,
} = schemaModule as unknown as Record<string, any>;

const log = pino({
  name: "flow-runner-core",
  level: process.env.LOG_LEVEL ?? "info",
});

// FIXME(any): dual drizzle-orm peer-dep variants.
export type Db = any;

export type RunFlowOptions = {
  db?: Db;
  runtimeRoot?: string;
  supervisorApi?: SupervisorApi;
  // M19 crash-recover (ADR-034): set by driveResume when re-dispatching a
  // crashed `retry_safe` session-less node. The runner resumes FROM
  // `targetStepId` (re-runs that node once) under a single-winner claim that
  // CAS-clears `resume_started_at`, instead of no-op'ing (graph) or restarting
  // from step 0 (linear).
  crashResume?: { targetStepId: string };
  // M17 Phase 3: set by the in-process repark tail-call after the repark CAS
  // commits. The repark CAS is the single-winner claim; this is a soft re-entry
  // with NO additional CAS.
  reparkResume?: { targetStepId: string };
};

export type LoadedRun = {
  run: RunRow;
  task: TaskRow;
  flow: FlowRow;
  executor: RunnerExecutor;
  manifest: FlowYamlV1;
  runner: RunnerSnapshot;
  workspace: WorkspaceRow;
  projectSlug: string;
  flowInstallPath: string;
};

export function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

export type RunnerExecutor = {
  id: string;
  executorRefId: string;
  agent: "claude" | "codex";
  model: string;
  env: Record<string, string> | null;
  router: "ccr" | null;
};

function runnerSnapshotFromRunner(row: PlatformAcpRunner): RunnerSnapshot {
  return {
    id: row.id,
    adapter: row.adapter,
    capabilityAgent: row.capabilityAgent,
    model: row.model,
    provider: row.provider,
    providerKind: row.provider.kind,
    permissionPolicy: row.permissionPolicy,
    sidecarId: row.sidecarId,
  };
}

function executorFromRunnerSnapshot(snapshot: RunnerSnapshot): RunnerExecutor {
  return {
    id: snapshot.id,
    executorRefId: snapshot.id,
    agent: snapshot.capabilityAgent as RunnerExecutor["agent"],
    model: snapshot.model,
    env: null,
    router: snapshot.sidecarId ? "ccr" : null,
  };
}

async function loadRunnerSnapshot(
  db: Db,
  run: RunRow,
  runId: string,
): Promise<RunnerSnapshot> {
  if (run.runnerSnapshot) return run.runnerSnapshot;

  if (run.runnerId) {
    const runnerRows: PlatformAcpRunner[] = await db
      .select()
      .from(platformAcpRunners)
      .where(eq(platformAcpRunners.id, run.runnerId));
    const runner = runnerRows[0];

    if (!runner) {
      throw new MaisterError(
        "EXECUTOR_UNAVAILABLE",
        `ACP runner ${run.runnerId} not found for run ${runId}`,
      );
    }

    return runnerSnapshotFromRunner(runner);
  }

  throw new MaisterError(
    "EXECUTOR_UNAVAILABLE",
    `no ACP runner snapshot found for run ${runId}`,
  );
}

// Loads a run plus its task/flow/runner/workspace and resolves the manifest +
// bundle path from the IMMUTABLE pinned revision (M10, ADR-021). Shared by the
// linear runner (runner.ts) and the graph runner (runner-graph.ts).
export async function loadRun(db: Db, runId: string): Promise<LoadedRun> {
  const runRows: RunRow[] = await db
    .select()
    .from(runs)
    .where(eq(runs.id, runId));
  const run = runRows[0];

  if (!run) {
    throw new MaisterError("PRECONDITION", `run not found: ${runId}`);
  }

  const taskRows: TaskRow[] = await db
    .select()
    .from(tasks)
    .where(eq(tasks.id, run.taskId));
  const task = taskRows[0];

  if (!task) {
    throw new MaisterError("PRECONDITION", `task not found for run ${runId}`);
  }

  const flowRows: FlowRow[] = await db
    .select()
    .from(flows)
    .where(eq(flows.id, run.flowId));
  const flow = flowRows[0];

  if (!flow) {
    throw new MaisterError("PRECONDITION", `flow not found for run ${runId}`);
  }

  const runner = await loadRunnerSnapshot(db, run, runId);
  const executor = executorFromRunnerSnapshot(runner);

  const projectRows: Array<{ slug: string }> = await db
    .select({ slug: projects.slug })
    .from(projects)
    .where(eq(projects.id, run.projectId));
  const projectSlug = projectRows[0]?.slug;

  if (!projectSlug) {
    throw new MaisterError(
      "PRECONDITION",
      `project not found for run ${runId}`,
    );
  }

  const workspaceRows: WorkspaceRow[] = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.runId, runId));
  const workspace = workspaceRows[0];

  if (!workspace) {
    throw new MaisterError(
      "PRECONDITION",
      `workspace not found for run ${runId}`,
    );
  }
  if (workspace.removedAt) {
    throw new MaisterError(
      "PRECONDITION",
      `workspace already removed for run ${runId}`,
    );
  }

  let manifest = flow.manifest as FlowYamlV1;
  let flowInstallPath = systemCachePath(flow.flowRefId, run.flowRevision);

  if (run.flowRevisionId) {
    const revisionRows: Array<{
      manifest: unknown;
      installedPath: string;
    }> = await db
      .select({
        manifest: flowRevisions.manifest,
        installedPath: flowRevisions.installedPath,
      })
      .from(flowRevisions)
      .where(eq(flowRevisions.id, run.flowRevisionId));
    const revision = revisionRows[0];

    if (!revision) {
      throw new MaisterError(
        "PRECONDITION",
        `pinned flow revision ${run.flowRevisionId} not found for run ${runId}`,
      );
    }

    manifest = revision.manifest as FlowYamlV1;
    flowInstallPath = revision.installedPath;
  }

  return {
    run,
    task,
    flow,
    manifest,
    executor,
    runner,
    workspace,
    projectSlug,
    flowInstallPath,
  };
}

// Deletes a lingering `slash-in-existing` ACP session on a terminal/pause exit.
export async function cleanupSlashSession(
  sessionState: AcpSessionState,
  deleteSession: (sessionId: string) => Promise<void> = defaultDeleteSession,
  logger: typeof log = log,
): Promise<void> {
  if (sessionState.currentSessionId === null) return;

  const sessionId = sessionState.currentSessionId;

  sessionState.currentSessionId = null;
  try {
    await deleteSession(sessionId);
    logger.info({ sessionId }, "slash-in-existing session deleted on terminal");
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, sessionId },
      "deleteSession failed during cleanup (non-fatal)",
    );
  }
}
