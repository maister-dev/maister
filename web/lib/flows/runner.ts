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

import { and, eq } from "drizzle-orm";
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
import { isMaisterError, MaisterError, type MaisterErrorCode } from "@/lib/errors";
import * as schemaModule from "@/lib/db/schema";
import { getDb } from "@/lib/db/client";
import { systemCachePath } from "@/lib/flow-paths";

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

  // Derive the bundle path from the immutable convention rather than
  // the mutable `flows.installed_path` column. The system cache is
  // keyed by `(flowRefId, revision)`; reading from a SHA-pinned
  // directory guarantees the run executes against the exact bytes it
  // was launched with, even if the operator re-installs the same tag
  // at a different commit while the run is in flight.
  return {
    run,
    task,
    flow,
    manifest: flow.manifest as FlowYamlV1,
    executor,
    workspace,
    projectSlug,
    flowInstallPath: systemCachePath(flow.flowRefId, run.flowRevision),
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

  if (loaded.run.status !== "Running" && loaded.run.status !== "NeedsInput") {
    throw new MaisterError(
      "PRECONDITION",
      `run ${runId} not in Running/NeedsInput state (got ${loaded.run.status})`,
    );
  }

  const isResume =
    loaded.run.status === "NeedsInput" && loaded.run.currentStepId !== null;

  if (isResume) {
    // Atomic resume claim: only ONE concurrent runFlow call for the
    // same NeedsInput row may transition it to Running and continue.
    // Without this guard, two near-simultaneous resume calls (the
    // original Phase 3 microtask + the same-payload retry's
    // re-queue) could both load NeedsInput, both flip to Running,
    // and both execute the resumed step plus every step after it —
    // duplicating side-effects and risking unique-constraint
    // failures on step_runs (run_id, step_id, attempt).
    const targetStepId = loaded.run.currentStepId;
    const acquired = await db.transaction(async (tx: Db) => {
      const rows: RunRow[] = await tx
        .select()
        .from(runs)
        .where(eq(runs.id, runId));
      const fresh = rows[0];

      if (!fresh) return false;
      if (fresh.status !== "NeedsInput") return false;
      if (fresh.currentStepId !== targetStepId) return false;

      await tx
        .update(runs)
        .set({ status: "Running" })
        .where(
          and(
            eq(runs.id, runId),
            eq(runs.status, "NeedsInput"),
            eq(runs.currentStepId, targetStepId),
          ),
        );

      return true;
    });

    if (!acquired) {
      log2.info(
        { currentStepId: targetStepId },
        "runFlow resume claim lost — another invocation is already executing this resume",
      );

      return;
    }

    loaded.run.status = "Running";
    log2.info(
      { currentStepId: targetStepId },
      "runFlow resume claim acquired — proceeding from NeedsInput",
    );
  }

  const worktreePath = loaded.workspace.worktreePath;
  const sessionState: AcpSessionState = {
    currentSessionId: null,
    lastSeenMonotonicId: 0,
  };

  let failed = false;
  let needsInput = false;
  // Track the highest-severity errorCode observed across the run so the
  // terminal write can distinguish CRASH (operational failure — runner
  // owes recovery) from ordinary Failed (step rejected the input). The
  // schema enum already supports both; without this accumulator the
  // terminal write would silently collapse CRASH to Failed.
  let runErrorCode: MaisterErrorCode | null = null;
  const allSteps = loaded.manifest.steps;
  const resumeIndex = isResume
    ? allSteps.findIndex((s) => s.id === loaded.run.currentStepId)
    : 0;

  // Defense-in-depth fail-closed: if the saved currentStepId is not in
  // the manifest, the run's pinned flow bundle has drifted (someone
  // hand-edited a SHA-keyed directory — a contract violation). DO NOT
  // silently start from step 0; mark Crashed and surface CONFIG.
  if (isResume && resumeIndex === -1) {
    log2.error(
      {
        currentStepId: loaded.run.currentStepId,
        flowRevision: loaded.run.flowRevision,
      },
      "stale resume pointer — currentStepId not in manifest; failing closed",
    );
    await db
      .update(runs)
      .set({ status: "Crashed", endedAt: new Date(), currentStepId: null })
      .where(eq(runs.id, runId));

    throw new MaisterError(
      "CONFIG",
      `currentStepId="${loaded.run.currentStepId}" not found in manifest for run ${runId}`,
    );
  }

  const stepsToRun = allSteps.slice(resumeIndex);

  try {
    for (const step of stepsToRun) {
      await db
        .update(runs)
        .set({ currentStepId: step.id })
        .where(eq(runs.id, runId));

      const mode = step.type === "agent" ? step.mode : undefined;
      const existingStepRuns = await getStepRunsForRun(runId, db);
      const lastForStep = [...existingStepRuns]
        .reverse()
        .find((sr) => sr.stepId === step.id);

      let stepRunId: string;

      if (
        isResume &&
        step.id === loaded.run.currentStepId &&
        lastForStep &&
        lastForStep.status === "NeedsInput"
      ) {
        stepRunId = lastForStep.id;
        log2.info(
          { stepRunId, stepId: step.id },
          "resuming existing step-run from NeedsInput",
        );
      } else {
        const created = await createStepRun({
          runId,
          stepId: step.id,
          stepType: step.type,
          mode,
          db,
        });

        stepRunId = created.id;
      }

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
        runErrorCode = e.code;
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
        const stepErrorCode = (result.errorCode ?? "PRECONDITION") as Exclude<
          StepResult["errorCode"],
          undefined
        >;

        await markStepFailed(
          stepRunId,
          {
            errorCode: stepErrorCode,
            exitCode: result.exitCode,
            stdout: result.stdout,
          },
          db,
        );
        failed = true;
        runErrorCode = stepErrorCode;
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
    runErrorCode = e.code;
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

  if (failed && runErrorCode === "CRASH") {
    // Operational failure (e.g. permission-persistence DB insert
    // failed mid-step). Distinct from ordinary Failed: operators are
    // expected to recover or discard via M12's reconciler. Without
    // this branch the terminal write would silently downgrade
    // Crashed → Failed and the runner-agent's CRASH propagation from
    // pass 2 would be erased here.
    await db
      .update(runs)
      .set({ status: "Crashed", endedAt, currentStepId: null })
      .where(eq(runs.id, runId));
    log2.error({ runErrorCode }, "runFlow ended Crashed");
  } else if (failed) {
    await db
      .update(runs)
      .set({ status: "Failed", endedAt, currentStepId: null })
      .where(eq(runs.id, runId));
    log2.warn({ runErrorCode }, "runFlow ended Failed");
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
