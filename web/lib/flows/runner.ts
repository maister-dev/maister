import "server-only";

import type {
  Executor as ExecutorRow,
  Flow as FlowRow,
  Run as RunRow,
  Task as TaskRow,
  Workspace as WorkspaceRow,
} from "@/lib/db/schema";
import type { FlowYamlV1, Step } from "@/lib/config.schema";
import type { AcpSessionState, FlowContext, StepResult } from "./types";

import { eq } from "drizzle-orm";
import pino from "pino";

import { buildContext } from "./context";
import { appendGuardMetric, evaluateGuards } from "./guards";
import { runAgentStep, type SupervisorApi } from "./runner-agent";
import { runCliStep } from "./runner-cli";
import { runHumanStep } from "./runner-human";
import {
  createStepRun,
  getStepRunsForRun,
  markStepFailed,
  markStepNeedsInput,
  markStepRunning,
  markStepSucceeded,
} from "./step-runs";

import { deleteSession as defaultDeleteSession } from "@/lib/supervisor-client";
import { promoteNextPending } from "@/lib/scheduler";
import { isMaisterError, MaisterError } from "@/lib/errors";
import * as schemaModule from "@/lib/db/schema";
import { getDb } from "@/lib/db/client";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { executors, flows, projects, runs, tasks, workspaces } =
  schemaModule as unknown as Record<string, any>;

const log = pino({
  name: "flow-runner",
  level: process.env.LOG_LEVEL ?? "info",
});

// FIXME(any): dual drizzle-orm peer-dep variants.
type Db = any;

export type RunFlowOptions = {
  db?: Db;
  runtimeRoot?: string;
  supervisorApi?: SupervisorApi;
};

type LoadedRun = {
  run: RunRow;
  task: TaskRow;
  flow: FlowRow;
  manifest: FlowYamlV1;
  executor: ExecutorRow;
  workspace: WorkspaceRow;
  projectSlug: string;
  flowInstallPath: string;
};

function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

async function loadRun(db: Db, runId: string): Promise<LoadedRun> {
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

  const executorRows: ExecutorRow[] = await db
    .select()
    .from(executors)
    .where(eq(executors.id, run.executorId));
  const executor = executorRows[0];

  if (!executor) {
    throw new MaisterError(
      "EXECUTOR_UNAVAILABLE",
      `executor not found for run ${runId}`,
    );
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

  return {
    run,
    task,
    flow,
    manifest: flow.manifest as FlowYamlV1,
    executor,
    workspace,
    projectSlug,
    flowInstallPath: flow.installedPath,
  };
}

async function executeStep(
  step: Step,
  loaded: LoadedRun,
  context: FlowContext,
  ctx: {
    runtimeRoot: string;
    worktreePath: string;
    sessionState: AcpSessionState;
    supervisorApi?: SupervisorApi;
  },
): Promise<StepResult & { needsInput?: boolean; acpSessionId?: string }> {
  const common = {
    runtimeRoot: ctx.runtimeRoot,
    projectSlug: loaded.projectSlug,
    runId: loaded.run.id,
    stepId: step.id,
    worktreePath: ctx.worktreePath,
    context,
  };

  switch (step.type) {
    case "cli":
      return runCliStep(step, common);
    case "agent":
      return runAgentStep(
        step,
        {
          ...common,
          executor: {
            id: loaded.executor.id,
            agent: loaded.executor.agent,
            model: loaded.executor.model,
            env: (loaded.executor.env ?? undefined) as
              | Record<string, string>
              | undefined,
            router: loaded.executor.router ?? undefined,
          },
          sessionState: ctx.sessionState,
        },
        ctx.supervisorApi,
      );
    case "guard": {
      const startedAt = Date.now();
      const metrics = evaluateGuards(
        [
          {
            cost: step.cost,
            time: step.time,
            regex: step.regex,
          },
        ],
        { durationMs: 0, stdout: "", costTokens: 0 },
      );

      await appendGuardMetric({
        runtimeRoot: ctx.runtimeRoot,
        projectSlug: loaded.projectSlug,
        runId: loaded.run.id,
        stepId: step.id,
        kind: "standalone",
        metrics,
      });

      return {
        ok: true,
        stdout: "",
        vars: {},
        durationMs: Date.now() - startedAt,
      };
    }
    case "human":
      return runHumanStep(step, {
        runtimeRoot: ctx.runtimeRoot,
        projectSlug: loaded.projectSlug,
        runId: loaded.run.id,
        stepId: step.id,
        flowInstallPath: loaded.flowInstallPath,
        context,
      });
    default:
      throw new MaisterError(
        "CONFIG",
        `unknown step type: ${(step as { type?: string }).type ?? "<unknown>"}`,
      );
  }
}

export async function runFlow(
  runId: string,
  opts: RunFlowOptions = {},
): Promise<void> {
  const db: Db = opts.db ?? getDb();
  const runtimeRoot = opts.runtimeRoot ?? process.cwd();
  const log2 = log.child({ runId });

  log2.info({}, "runFlow start");

  let loaded: LoadedRun;

  try {
    loaded = await loadRun(db, runId);
  } catch (err) {
    log2.error({ err: (err as Error).message }, "runFlow loadRun failed");
    throw err;
  }

  if (loaded.run.status !== "Running") {
    throw new MaisterError(
      "PRECONDITION",
      `run ${runId} not in Running state (got ${loaded.run.status})`,
    );
  }

  const worktreePath = loaded.workspace.worktreePath;
  const sessionState: AcpSessionState = {
    currentSessionId: null,
    lastSeenMonotonicId: 0,
  };

  let failed = false;
  let needsInput = false;

  try {
    for (const step of loaded.manifest.steps) {
      await db
        .update(runs)
        .set({ currentStepId: step.id })
        .where(eq(runs.id, runId));

      const mode = step.type === "agent" ? step.mode : undefined;
      const { id: stepRunId } = await createStepRun({
        runId,
        stepId: step.id,
        stepType: step.type,
        mode,
        db,
      });

      await markStepRunning(stepRunId, db);

      const stepRunsCurrent = await getStepRunsForRun(runId, db);
      const context = buildContext({
        task: loaded.task,
        run: loaded.run,
        executor: loaded.executor,
        stepRuns: stepRunsCurrent,
        projectSlug: loaded.projectSlug,
      });

      let result: Awaited<ReturnType<typeof executeStep>>;

      try {
        result = await executeStep(step, loaded, context, {
          runtimeRoot,
          worktreePath,
          sessionState,
          supervisorApi: opts.supervisorApi,
        });
      } catch (err) {
        const e = isMaisterError(err)
          ? err
          : new MaisterError("CRASH", asError(err).message, {
              cause: asError(err),
            });

        log2.error(
          { stepId: step.id, code: e.code, err: e.message },
          "step threw — marking Failed",
        );
        await markStepFailed(stepRunId, { errorCode: e.code }, db);
        failed = true;
        break;
      }

      if (result.needsInput) {
        await markStepNeedsInput(stepRunId, db);
        await db
          .update(runs)
          .set({ status: "NeedsInput", currentStepId: step.id })
          .where(eq(runs.id, runId));
        if (result.acpSessionId && !loaded.run.acpSessionId) {
          await db
            .update(runs)
            .set({ acpSessionId: result.acpSessionId })
            .where(eq(runs.id, runId));
        }
        needsInput = true;
        log2.info({ stepId: step.id }, "step requested NeedsInput");
        break;
      }

      if (!result.ok) {
        await markStepFailed(
          stepRunId,
          {
            errorCode: (result.errorCode ?? "PRECONDITION") as Exclude<
              StepResult["errorCode"],
              undefined
            >,
            exitCode: result.exitCode,
            stdout: result.stdout,
          },
          db,
        );
        failed = true;
        log2.warn(
          {
            stepId: step.id,
            errorCode: result.errorCode,
            exitCode: result.exitCode,
          },
          "step failed",
        );
        break;
      }

      if (result.acpSessionId && !loaded.run.acpSessionId) {
        await db
          .update(runs)
          .set({ acpSessionId: result.acpSessionId })
          .where(eq(runs.id, runId));
        loaded.run.acpSessionId = result.acpSessionId;
      }

      await markStepSucceeded(
        stepRunId,
        {
          stdout: result.stdout,
          vars: result.vars,
          exitCode: result.exitCode,
          acpSessionId: result.acpSessionId,
        },
        db,
      );
    }
  } catch (err) {
    const e = isMaisterError(err)
      ? err
      : new MaisterError("CRASH", asError(err).message, {
          cause: asError(err),
        });

    log2.error({ err: e.message, code: e.code }, "runFlow top-level error");
    failed = true;
  }

  if (needsInput) {
    log2.info({}, "runFlow paused on NeedsInput");
    await cleanupSlashSession(
      sessionState,
      opts.supervisorApi?.deleteSession ?? defaultDeleteSession,
      log2,
    );

    return;
  }

  const endedAt = new Date();

  if (failed) {
    await db
      .update(runs)
      .set({ status: "Failed", endedAt, currentStepId: null })
      .where(eq(runs.id, runId));
    log2.warn({}, "runFlow ended Failed");
  } else {
    await db
      .update(runs)
      .set({ status: "Review", endedAt, currentStepId: null })
      .where(eq(runs.id, runId));
    log2.info({}, "runFlow ended Review");
  }

  await cleanupSlashSession(
    sessionState,
    opts.supervisorApi?.deleteSession ?? defaultDeleteSession,
    log2,
  );

  try {
    // Pass only run-agnostic options to the promoted run — each run loads
    // its own workspace + executor from the DB. Critically NOT propagating
    // any per-run state (worktreePath, sessionState, etc.) so the next
    // queued run cannot inherit this run's worktree.
    const nextOpts: RunFlowOptions = {
      db: opts.db,
      runtimeRoot: opts.runtimeRoot,
      supervisorApi: opts.supervisorApi,
    };

    await promoteNextPending({
      db,
      runFlow: (next) => void runFlow(next, nextOpts),
    });
  } catch (err) {
    log2.error(
      { err: (err as Error).message },
      "promoteNextPending failed (non-fatal)",
    );
  }
}

async function cleanupSlashSession(
  sessionState: AcpSessionState,
  deleteSession: (sessionId: string) => Promise<void>,
  logger: typeof log,
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
