import "server-only";

import type {
  Flow as FlowRow,
  FlowRevisionExecTrust,
  PlatformAcpRunner,
  Run as RunRow,
  RunnerSnapshot,
  Task as TaskRow,
  Workspace as WorkspaceRow,
} from "@/lib/db/schema";
import type { CapabilityAgent, FlowYamlV1 } from "@/lib/config.schema";
import type { AcpSessionState } from "../types";
import type { SupervisorApi } from "../runner-agent";

import { eq } from "drizzle-orm";
import pino from "pino";

import { deleteSession as defaultDeleteSession } from "@/lib/supervisor-client";
import { MaisterError } from "@/lib/errors";
import { requireRunProjectId } from "@/lib/runs/run-kind-invariants";
import * as schemaModule from "@/lib/db/schema";
import { systemCachePath } from "@/lib/flow-paths";

// FIXME(any): dual drizzle-orm peer-dep variants.
const {
  flowRevisions,
  flows,
  platformAcpRunners,
  projects,
  runs,
  runSessions,
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
  // M37 (ADR-098) T5.2: set by the orchestrator-resume domain-event consumer
  // after it wins the WaitingOnChildren → Running CAS (markResumedFromWait —
  // that IS the single-winner claim). The runner re-enters the parked
  // orchestrator node, reusing its NeedsInput ledger attempt and restoring the
  // coordinator's context via session/resume on the retained acp_session_id.
  orchestratorResume?: { targetStepId: string };
  // M41 (ADR-109): same WaitingOnChildren CAS/re-entry pattern for consensus.
  // Unlike orchestrator, consensus has no coordinator ACP session to resume; the
  // node re-enters to recollect settled drafts and continue verify/tally.
  consensusResume?: { targetStepId: string };
};

// M42 (ADR-114): a run's logical session — its concrete host runner snapshot and
// the resume handle (`acp_session_id`) for the ACP process serving it. Sourced
// from `run_sessions` (the sole source of truth); a legacy run with no rows maps
// the implicit `default` session onto the run-level runner snapshot.
export type LoadedRunSession = {
  sessionName: string;
  runner: RunnerSnapshot;
  acpSessionId: string | null;
  capabilityAgent: string | null;
  runnerResolutionTier: string | null;
};

export type LoadedRun = {
  // ADR-100: the graph/linear runner only loads flow runs (loadRun requires a
  // task + flow + project), so project_id is non-null here even though the base
  // Run type made it nullable for the project-less local-package variant.
  run: RunRow & { projectId: string };
  task: TaskRow;
  flow: FlowRow;
  executor: RunnerExecutor;
  manifest: FlowYamlV1;
  runner: RunnerSnapshot;
  // M42 (ADR-114): the run's session set keyed by session name; the per-node
  // dispatch resolves the node's session runner + resume handle from here.
  sessions: Map<string, LoadedRunSession>;
  workspace: WorkspaceRow;
  projectSlug: string;
  flowInstallPath: string;
  // M27/T-C8b: exec-trust of the pinned flow revision; gates stdio-MCP spawn.
  execTrust: FlowRevisionExecTrust;
};

export function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

export type RunnerExecutor = {
  id: string;
  executorRefId: string;
  agent: CapabilityAgent;
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
    env: row.env,
    provider: row.provider,
    providerKind: row.provider.kind,
    permissionPolicy: row.permissionPolicy,
    sidecarId: row.sidecarId,
  };
}

export function executorFromRunnerSnapshot(
  snapshot: RunnerSnapshot,
): RunnerExecutor {
  return {
    id: snapshot.id,
    executorRefId: snapshot.id,
    agent: snapshot.capabilityAgent as RunnerExecutor["agent"],
    model: snapshot.model,
    env: null,
    router: snapshot.sidecarId ? "ccr" : null,
  };
}

// M42 (ADR-114): the run-level runner is resolved from the run's DEFAULT logical
// session (run_sessions), not the dropped run-level mirror columns. `source` is
// the default session's `{ runnerSnapshot, runnerId }`.
async function loadRunnerSnapshot(
  db: Db,
  source: { runnerSnapshot: RunnerSnapshot | null; runnerId: string | null },
  runId: string,
): Promise<RunnerSnapshot> {
  if (source.runnerSnapshot) return source.runnerSnapshot;

  if (source.runnerId) {
    const runnerRows: PlatformAcpRunner[] = await db
      .select()
      .from(platformAcpRunners)
      .where(eq(platformAcpRunners.id, source.runnerId));
    const runner = runnerRows[0];

    if (!runner) {
      throw new MaisterError(
        "EXECUTOR_UNAVAILABLE",
        `ACP runner ${source.runnerId} not found for run ${runId}`,
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

  // M42 (ADR-114): the run's logical sessions are the SOLE source of runner
  // truth. The run-level `runner`/`executor` (used by default-session nodes and
  // capability materialization) is the DEFAULT session's runner.
  const runSessionRows: Array<Record<string, any>> = await db
    .select()
    .from(runSessions)
    .where(eq(runSessions.runId, runId));
  const defaultRow =
    runSessionRows.find((row) => row.sessionName === "default") ??
    runSessionRows[0];
  const runner = await loadRunnerSnapshot(
    db,
    {
      runnerSnapshot: (defaultRow?.runnerSnapshot ?? null) as RunnerSnapshot | null,
      runnerId: (defaultRow?.runnerId ?? null) as string | null,
    },
    runId,
  );
  const executor = executorFromRunnerSnapshot(runner);

  const sessions = new Map<string, LoadedRunSession>(
    runSessionRows.map((row) => [
      row.sessionName as string,
      {
        sessionName: row.sessionName as string,
        runner: (row.runnerSnapshot ?? runner) as RunnerSnapshot,
        acpSessionId: (row.acpSessionId ?? null) as string | null,
        capabilityAgent: (row.capabilityAgent ?? null) as string | null,
        runnerResolutionTier: (row.runnerResolutionTier ?? null) as
          | string
          | null,
      },
    ]),
  );

  // A run with NO session rows (should not occur post-cutover — every creator
  // writes at least a `default`) still resolves to a usable single session.
  if (!sessions.has("default")) {
    sessions.set("default", {
      sessionName: "default",
      runner,
      acpSessionId: null,
      capabilityAgent: null,
      runnerResolutionTier: null,
    });
  }

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
  // M27/T-C8b: a run with no pinned revision (legacy / pre-bridge) is treated as
  // exec-trusted (no stdio-MCP gate); a pinned revision carries its own axis.
  let execTrust: FlowRevisionExecTrust = "trusted";

  if (run.flowRevisionId) {
    const revisionRows: Array<{
      manifest: unknown;
      installedPath: string;
      execTrust: FlowRevisionExecTrust;
    }> = await db
      .select({
        manifest: flowRevisions.manifest,
        installedPath: flowRevisions.installedPath,
        execTrust: flowRevisions.execTrust,
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
    execTrust = revision.execTrust;
  }

  return {
    // project_id is guaranteed (a flow run always has a project; ADR-097).
    run: { ...run, projectId: requireRunProjectId(run.projectId, runId) },
    task,
    flow,
    manifest,
    executor,
    runner,
    sessions,
    workspace,
    projectSlug,
    flowInstallPath,
    execTrust,
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
