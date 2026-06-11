import "server-only";

import type { Run as RunRow } from "@/lib/db/schema";
import type { Step } from "@/lib/config.schema";
import type { AcpSessionState, FlowContext, StepResult } from "./types";

import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";

import { and, eq, isNotNull } from "drizzle-orm";
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
import {
  asError,
  cleanupSlashSession,
  loadRun,
  type Db,
  type LoadedRun,
  type RunFlowOptions,
} from "./graph/runner-core";
import { runGraph } from "./graph/runner-graph";
import { recordDefaultArtifacts } from "./graph/default-artifacts";
import { getArtifactsForRun } from "./graph/artifact-store";

import {
  mergeRunnerAdapterLaunch,
  runnerSupervisorInput,
} from "@/lib/acp-runners/spawn-intent";
import { atomicWriteJson } from "@/lib/atomic";
import { systemCloseActiveAssignmentsForRun } from "@/lib/assignments/service";
import { promoteNextPending } from "@/lib/scheduler";
import {
  isMaisterError,
  MaisterError,
  type MaisterErrorCode,
} from "@/lib/errors";
import * as schemaModule from "@/lib/db/schema";
import { getDb } from "@/lib/db/client";
import { emitWebhookEvent } from "@/lib/webhooks/outbox";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { runs } = schemaModule as unknown as Record<string, any>;

const log = pino({
  name: "flow-runner",
  level: process.env.LOG_LEVEL ?? "info",
});

// M17 Phase 3: on_reject repark loop guard (mirrors graph rework.maxLoops).
const MAX_REWORK_LOOPS = 5;

export type { RunFlowOptions } from "./graph/runner-core";

async function executeStep(
  step: Step,
  loaded: LoadedRun,
  context: FlowContext,
  ctx: {
    runtimeRoot: string;
    worktreePath: string;
    sessionState: AcpSessionState;
    supervisorApi?: SupervisorApi;
    db: Db;
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
          runner: runnerSupervisorInput({ snapshot: loaded.runner }),
          sessionState: ctx.sessionState,
          adapterLaunch: mergeRunnerAdapterLaunch(loaded.runner),
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
        db: ctx.db,
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

  // M11a: a graph manifest (`nodes[]`) runs through the graph runner, which
  // writes the append-only node_attempts ledger + gates + rework. Linear
  // `steps[]` flows stay on the proven linear path below (writing step_runs);
  // both feed the highest-attempt-wins templating union. A pre-M11a NeedsInput
  // run is always a steps[] flow, so it resumes here unchanged (no seed needed).
  if (loaded.manifest.nodes && loaded.manifest.nodes.length > 0) {
    await runGraph(loaded, {
      db,
      runtimeRoot,
      supervisorApi: opts.supervisorApi,
      crashResume: opts.crashResume,
    });

    return;
  }

  if (loaded.run.status !== "Running" && loaded.run.status !== "NeedsInput") {
    throw new MaisterError(
      "PRECONDITION",
      `run ${runId} not in Running/NeedsInput state (got ${loaded.run.status})`,
    );
  }

  // M19 crash-recover (ADR-034): a redispatch of a crashed `retry_safe` linear
  // node enters as `Running` with `crashResume.targetStepId`. Without this, a
  // `Running` linear run has isResume=false → restarts from step 0 (Codex
  // round-3: duplicates earlier side effects). Claim it single-winner by
  // CAS-clearing `resume_started_at`; the loser (already cleared) bails.
  const crashResumeStepId =
    opts.crashResume && loaded.run.status === "Running"
      ? opts.crashResume.targetStepId
      : null;

  if (crashResumeStepId !== null) {
    const claimed = await db
      .update(runs)
      .set({ resumeStartedAt: null })
      .where(and(eq(runs.id, runId), isNotNull(runs.resumeStartedAt)))
      .returning({ id: runs.id });

    if (claimed.length === 0) {
      log2.info(
        { targetStepId: crashResumeStepId },
        "runFlow crash-resume claim lost — another invocation owns this resume",
      );

      return;
    }
    // Resume from the retained crashed node, not step 0.
    loaded.run.currentStepId = crashResumeStepId;
  }

  // M17 Phase 3: reparkResume — the in-process tail-call after the repark CAS
  // commits (the explicit re-entry of the repark winner). No additional CAS is
  // needed: the repark CAS is the single-winner claim. A reparked-`Running`
  // linear run whose process died after the commit (window-(c)) is recovered
  // via the existing crash path, NOT auto-redispatch: reconcile classifies a
  // session-less linear gate/human run `crash` (reason `linear-gate-orphan`),
  // `crashRunningRun` retains the goto target in `resume_target_step_id`, and
  // operator Recover (`resumeCrashedRun` → `driveResume`) threads
  // `crashResume.targetStepId` so re-entry resumes FROM the goto target — never
  // a bare `runFlow` that would restart at step 0 and re-run prior side-effects.
  // This is why we do NOT treat every Running+currentStepId run as a repark
  // (that would misclassify a plain promote/manual re-dispatch and break the
  // step_runs double-execution guard).
  const reparkResumeStepId =
    opts.reparkResume && loaded.run.status === "Running"
      ? opts.reparkResume.targetStepId
      : null;

  if (reparkResumeStepId !== null) {
    loaded.run.currentStepId = reparkResumeStepId;
  }

  // A NeedsInput resume (status NeedsInput) claims via the NeedsInput→Running
  // CAS below; a crash-resume (status already Running) already claimed above via
  // CAS-clear resume_started_at. `isResume` drives resumeIndex/stepsToRun for both.
  const isNeedsInputResume =
    loaded.run.status === "NeedsInput" && loaded.run.currentStepId !== null;
  const isResume =
    isNeedsInputResume ||
    crashResumeStepId !== null ||
    reparkResumeStepId !== null;

  if (isNeedsInputResume) {
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
  // M8 Codex review fix #1: the runner-agent reported a session.exited
  // .reason="checkpoint" mid-step. The agent's markCheckpointedFromExit
  // has already transitioned the row NeedsInput → NeedsInputIdle. The
  // step is paused, not failed; the run's slot is now FREE (NeedsInputIdle
  // doesn't count against the cap), so we must promoteNextPending on the
  // way out — unlike the plain `needsInput` branch where the slot stays
  // busy via NeedsInput.
  let checkpointed = false;
  // Track the highest-severity errorCode observed across the run so the
  // terminal write can distinguish CRASH (operational failure — runner
  // owes recovery) from ordinary Failed (step rejected the input). The
  // schema enum already supports both; without this accumulator the
  // terminal write would silently collapse CRASH to Failed.
  let runErrorCode: MaisterErrorCode | null = null;
  // M17 Phase 3: set when the repark CAS commits; skips the terminal write
  // so the in-process tail-call can re-enter at the goto target.
  let reparkedTo: string | null = null;
  // M11a: `steps` is optional on the manifest (graph flows use `nodes[]` and run
  // through the graph runner, Phase 3). The linear runner handles `steps[]` only.
  const allSteps = loaded.manifest.steps ?? [];
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
    await db.transaction(async (tx: Db) => {
      const rows = await tx
        .update(runs)
        .set({ status: "Crashed", endedAt: new Date(), currentStepId: null })
        .where(eq(runs.id, runId))
        .returning({ projectId: runs.projectId });

      if (rows.length > 0) {
        await emitWebhookEvent({
          db: tx,
          type: "run.crashed",
          projectId: rows[0].projectId,
          runId,
          data: { errorCode: "CONFIG" },
        });
      }
    });

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
      // The attempt of the step_run actually executing this iteration — drives
      // evidence binding (recordDefaultArtifacts) so rework artifacts attach to
      // the current pass, not attempt 1.
      let currentAttempt: number;

      if (
        isResume &&
        step.id === loaded.run.currentStepId &&
        lastForStep &&
        lastForStep.status === "NeedsInput"
      ) {
        stepRunId = lastForStep.id;
        currentAttempt = lastForStep.attempt;
        log2.info(
          { stepRunId, stepId: step.id },
          "resuming existing step-run from NeedsInput",
        );
      } else {
        // Re-executing an already-run step needs a fresh attempt number to avoid
        // the step_runs unique constraint (run_id, step_id, attempt). Two cases:
        //   1. on_reject repark re-entry (reparkResume).
        //   2. ADR-056 crash-resume re-entering a step whose latest step_run is
        //      already terminal — the pre-repark-CAS crash window: markStepSucceeded
        //      committed but the repark CAS had not, so crashRunningRun retained the
        //      human step (not the goto) in resume_target_step_id and Recover
        //      re-enters here with that step_run already Succeeded. Without the
        //      increment, createStepRun(attempt=1) collides and Recover never
        //      succeeds.
        // A first-ever execution keeps attempt=1 so the constraint still guards
        // against accidental double-execution (promote + manual re-dispatch race).
        const attemptsForStep = existingStepRuns.filter(
          (sr) => sr.stepId === step.id,
        );
        const reExecuting =
          reparkResumeStepId !== null ||
          (isResume && attemptsForStep.length > 0);
        const attempt =
          reExecuting && attemptsForStep.length
            ? Math.max(...attemptsForStep.map((sr) => sr.attempt)) + 1
            : 1;

        if (reExecuting && reparkResumeStepId === null) {
          log2.info(
            { stepId: step.id, attempt, priorAttempts: attemptsForStep.length },
            "[FIX] crash-resume re-entering a terminal step — fresh attempt (ADR-056 pre-CAS window)",
          );
        }

        const created = await createStepRun({
          runId,
          stepId: step.id,
          stepType: step.type,
          mode,
          attempt,
          db,
        });

        stepRunId = created.id;
        currentAttempt = attempt;
      }

      await markStepRunning(stepRunId, db);

      const stepRunsCurrent = await getStepRunsForRun(runId, db);
      // M12 (T3.4): pass current artifacts for template rendering.
      const currentArtifacts = await getArtifactsForRun(runId, db);

      // M17 Phase 3: inject rework comments as extraVars when present.
      // rework-comments-<step.id>.json is written by the repark path (pre-tx)
      // before the repark CAS commits. Left on disk (harmless orphan; overwritten
      // on next repark — ADR-056 crash-window (c)).
      let reworkComments: Record<string, unknown> | undefined;
      const reworkCommentsPath = join(
        runtimeRoot,
        ".maister",
        loaded.projectSlug,
        "runs",
        runId,
        `rework-comments-${step.id}.json`,
      );

      try {
        const raw = await readFile(reworkCommentsPath, "utf8");
        const parsed: unknown = JSON.parse(raw);

        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          reworkComments = parsed as Record<string, unknown>;
          log2.debug(
            { stepId: step.id, keys: Object.keys(reworkComments) },
            "rework-comments injected as extraVars",
          );
        }
      } catch {
        // ENOENT or bad JSON → no injection; step runs without comments.
      }

      const context = buildContext({
        task: loaded.task,
        run: loaded.run,
        executor: loaded.executor,
        stepRuns: stepRunsCurrent,
        projectSlug: loaded.projectSlug,
        artifacts: currentArtifacts,
        extraVars: reworkComments,
      });

      let result: Awaited<ReturnType<typeof executeStep>>;

      try {
        result = await executeStep(step, loaded, context, {
          runtimeRoot,
          worktreePath,
          sessionState,
          supervisorApi: opts.supervisorApi,
          db,
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
        // Ledger mark + status flip + run.needs_input outbox row are one
        // logical transition — they commit atomically or not at all.
        await db.transaction(async (tx: Db) => {
          await markStepNeedsInput(stepRunId, tx);
          const flipped = await tx
            .update(runs)
            .set({ status: "NeedsInput", currentStepId: step.id })
            .where(eq(runs.id, runId))
            .returning({ projectId: runs.projectId });

          if (flipped.length > 0) {
            // Only the human step yields needsInput on the linear path; its HITL
            // kind (and thus the reason) mirrors runHumanStep's on_reject branch.
            const reason: "human" | "form" =
              step.type === "human" && step.on_reject ? "human" : "form";

            await emitWebhookEvent({
              db: tx,
              type: "run.needs_input",
              projectId: flipped[0].projectId,
              runId,
              data: { reason, nodeId: null },
            });
          }
        });
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

      // M17 Phase 3: on_reject repark.
      if (result.rework) {
        const { gotoStepId, commentsVar, comments } = result.rework;
        const humanIndex = allSteps.findIndex((s) => s.id === step.id);
        const gotoIndex = allSteps.findIndex((s) => s.id === gotoStepId);

        if (gotoIndex === -1) {
          await markStepFailed(stepRunId, { errorCode: "CONFIG" }, db);
          throw new MaisterError(
            "CONFIG",
            `on_reject.goto_step "${gotoStepId}" not found in manifest for run ${runId}`,
          );
        }

        // maxLoops guard (ADR-056): bound BOTH this human step's own loops AND
        // the run-WIDE repark budget, so N independent human on_reject steps
        // cannot each loop MAX_REWORK_LOOPS times (the 5×N gap). A repark always
        // re-runs its triggering human step, so the run-wide repark count ==
        // (total human-step executions − distinct human steps that ran). Both
        // counts are derived from step_runs (durable; survives respawn).
        const freshStepRuns = await getStepRunsForRun(runId, db);
        const humanRunCount = freshStepRuns.filter(
          (sr) => sr.stepId === step.id,
        ).length;
        const humanStepIds = new Set(
          allSteps.filter((s) => s.type === "human").map((s) => s.id),
        );
        const humanStepRuns = freshStepRuns.filter((sr) =>
          humanStepIds.has(sr.stepId),
        );
        const runReparkCount =
          humanStepRuns.length -
          new Set(humanStepRuns.map((sr) => sr.stepId)).size;

        log2.debug(
          {
            stepId: step.id,
            humanRunCount,
            runReparkCount,
            max: MAX_REWORK_LOOPS,
          },
          "rework loop guard check",
        );

        if (
          humanRunCount > MAX_REWORK_LOOPS ||
          runReparkCount >= MAX_REWORK_LOOPS
        ) {
          log2.warn(
            {
              stepId: step.id,
              humanRunCount,
              runReparkCount,
              max: MAX_REWORK_LOOPS,
            },
            "on_reject maxLoops exceeded — failing run CONFIG",
          );
          await markStepFailed(stepRunId, { errorCode: "CONFIG" }, db);
          throw new MaisterError(
            "CONFIG",
            `on_reject exceeded maxLoops (${MAX_REWORK_LOOPS}) for run ${runId} (step "${step.id}", humanRunCount=${humanRunCount}, runReparkCount=${runReparkCount})`,
          );
        }

        // Mark the human step succeeded (it DID complete; produced a reject).
        await markStepSucceeded(
          stepRunId,
          { stdout: result.stdout, vars: result.vars },
          db,
        );

        // ORDER MATTERS (ADR-056 clause 2):
        // 1. (over)write rework-comments-<gotoStepId>.json (pre-tx). UNCONDITIONAL
        //    so a prior pass's comments for this SAME goto target can never be
        //    re-injected when the current reject carries no comments_var — write
        //    an empty object in that case (no injection).
        const commentsFilePath = join(
          runtimeRoot,
          ".maister",
          loaded.projectSlug,
          "runs",
          runId,
          `rework-comments-${gotoStepId}.json`,
        );

        await atomicWriteJson(
          commentsFilePath,
          commentsVar ? { [commentsVar]: comments ?? "" } : {},
        );
        log2.info(
          { runId, gotoStepId, commentsVar: commentsVar ?? null },
          "repark: wrote rework-comments file",
        );

        // 2. Delete input sentinels for every step in [gotoIndex, humanIndex+1)
        //    so re-reached steps re-prompt instead of auto-satisfying.
        const stepsToInvalidate = allSteps.slice(gotoIndex, humanIndex + 1);

        for (const s of stepsToInvalidate) {
          const inputPath = join(
            runtimeRoot,
            ".maister",
            loaded.projectSlug,
            "runs",
            runId,
            `input-${s.id}.json`,
          );

          await unlink(inputPath).catch((e: unknown) => {
            if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
          });
        }

        log2.info(
          {
            runId,
            from: step.id,
            to: gotoStepId,
            deletedSentinels: stepsToInvalidate.map((s) => s.id),
          },
          "repark: window sentinels cleared",
        );

        // 3. Repark CAS: single-winner claim.
        const reparkClaimed: Array<{ id: string }> = await db
          .update(runs)
          .set({ currentStepId: gotoStepId })
          .where(
            and(
              eq(runs.id, runId),
              eq(runs.status, "Running"),
              eq(runs.currentStepId, step.id),
            ),
          )
          .returning({ id: runs.id });

        if (reparkClaimed.length === 0) {
          // Another writer changed state; bail without a terminal write.
          log2.warn(
            { runId, from: step.id, to: gotoStepId },
            "repark CAS lost — another writer changed run state; bailing",
          );

          return;
        }

        log2.info(
          { runId, from: step.id, to: gotoStepId },
          "repark CAS committed — tail-call re-entering at goto target",
        );
        reparkedTo = gotoStepId;
        break;
      }

      if (result.errorCode === "STEP_CHECKPOINTED") {
        // The runner-agent observed `session.exited.reason="checkpoint"`
        // mid-step and already called markCheckpointedFromExit (row is
        // now NeedsInputIdle). Mark the step_runs row as paused and
        // persist acpSessionId for future --resume. DO NOT write
        // runs.status (would race with markCheckpointedFromExit).
        // DO NOT mark the step Failed — the step is paused, not failed,
        // and the resume-driver will replay this same step on operator
        // response.
        await markStepNeedsInput(stepRunId, db);
        if (result.acpSessionId && !loaded.run.acpSessionId) {
          await db
            .update(runs)
            .set({ acpSessionId: result.acpSessionId })
            .where(eq(runs.id, runId));
        }
        checkpointed = true;
        log2.info(
          { stepId: step.id },
          "[FIX] step paused by supervisor checkpoint — runFlow exiting cleanly, slot freed",
        );
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

      // M12 (T3.3): record default artifacts at step finish.
      await recordDefaultArtifacts(
        {
          runId,
          stepRunId,
          nodeId: step.id,
          attempt: currentAttempt,
          projectSlug: loaded.projectSlug,
          workspace: loaded.workspace,
          runtimeRoot,
        },
        db,
      ).catch((err) => {
        log2.warn(
          { stepId: step.id, err: (err as Error).message },
          "recordDefaultArtifacts failed (non-fatal)",
        );
      });
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
      opts.supervisorApi?.deleteSession,
      log2,
    );

    return;
  }

  if (checkpointed) {
    log2.info(
      {},
      "[FIX] runFlow paused on STEP_CHECKPOINTED — run is NeedsInputIdle, slot freed",
    );
    await cleanupSlashSession(
      sessionState,
      opts.supervisorApi?.deleteSession,
      log2,
    );
    try {
      const nextOpts: RunFlowOptions = {
        db: opts.db,
        runtimeRoot: opts.runtimeRoot,
        supervisorApi: opts.supervisorApi,
      };

      await promoteNextPending({
        db,
        runFlow: (next) =>
          void runFlow(next, nextOpts).catch((e) => {
            log2.error(
              { err: (e as Error).message },
              "promoted runFlow failed (non-fatal)",
            );
          }),
      });
    } catch (err) {
      log2.error(
        { err: (err as Error).message },
        "[FIX] promoteNextPending after STEP_CHECKPOINTED failed (non-fatal)",
      );
    }

    return;
  }

  // M17 Phase 3: repark tail-call — skip the terminal write, re-enter at goto.
  if (reparkedTo !== null && !needsInput && !checkpointed && !failed) {
    log2.info(
      { from: loaded.run.currentStepId, to: reparkedTo },
      "repark tail-call: re-entering runFlow at goto target",
    );
    await cleanupSlashSession(
      sessionState,
      opts.supervisorApi?.deleteSession,
      log2,
    );

    return runFlow(runId, {
      ...opts,
      reparkResume: { targetStepId: reparkedTo },
    });
  }

  const endedAt = new Date();

  if (failed && runErrorCode === "CRASH") {
    // Operational failure (e.g. permission-persistence DB insert
    // failed mid-step). Distinct from ordinary Failed: operators are
    // expected to recover or discard via M12's reconciler. Without
    // this branch the terminal write would silently downgrade
    // Crashed → Failed and the runner-agent's CRASH propagation from
    // pass 2 would be erased here.
    await db.transaction(async (tx: Db) => {
      const rows = await tx
        .update(runs)
        .set({ status: "Crashed", endedAt, currentStepId: null })
        .where(and(eq(runs.id, runId), eq(runs.status, "Running")))
        .returning({ projectId: runs.projectId });

      if (rows.length > 0) {
        await emitWebhookEvent({
          db: tx,
          type: "run.crashed",
          projectId: rows[0].projectId,
          runId,
          data: { errorCode: runErrorCode },
        });
      }
    });
    await systemCloseActiveAssignmentsForRun({
      db,
      runId,
      reason: "linear flow crashed",
    });
    log2.error({ runErrorCode }, "runFlow ended Crashed");
  } else if (failed) {
    await db.transaction(async (tx: Db) => {
      const rows = await tx
        .update(runs)
        .set({ status: "Failed", endedAt, currentStepId: null })
        .where(and(eq(runs.id, runId), eq(runs.status, "Running")))
        .returning({ projectId: runs.projectId });

      if (rows.length > 0) {
        await emitWebhookEvent({
          db: tx,
          type: "run.failed",
          projectId: rows[0].projectId,
          runId,
          data: { errorCode: runErrorCode },
        });
      }
    });
    await systemCloseActiveAssignmentsForRun({
      db,
      runId,
      reason: "linear flow failed",
    });
    log2.warn({ runErrorCode }, "runFlow ended Failed");
  } else {
    await db.transaction(async (tx: Db) => {
      const rows = await tx
        .update(runs)
        .set({ status: "Review", endedAt, currentStepId: null })
        .where(and(eq(runs.id, runId), eq(runs.status, "Running")))
        .returning({ projectId: runs.projectId });

      if (rows.length > 0) {
        await emitWebhookEvent({
          db: tx,
          type: "run.review",
          projectId: rows[0].projectId,
          runId,
          data: { source: "runner" },
        });
      }
    });
    log2.info({}, "runFlow ended Review");
  }

  await cleanupSlashSession(
    sessionState,
    opts.supervisorApi?.deleteSession,
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
      runFlow: (next) =>
        void runFlow(next, nextOpts).catch((e) => {
          log2.error(
            { err: (e as Error).message },
            "promoted runFlow failed (non-fatal)",
          );
        }),
    });
  } catch (err) {
    log2.error(
      { err: (err as Error).message },
      "promoteNextPending failed (non-fatal)",
    );
  }
}
