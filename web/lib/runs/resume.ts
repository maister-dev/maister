import "server-only";

import { eq } from "drizzle-orm";
import pino from "pino";

import {
  failResumedRun,
  markResumed,
  rollbackResumedRun,
} from "./state-transitions";

import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import {
  isMaisterError,
  MaisterError,
  type MaisterErrorCode,
} from "@/lib/errors";
import { createSession } from "@/lib/supervisor-client";
import {
  mergeRunnerAdapterLaunch,
  runnerExecutorInput,
  runnerSupervisorInput,
} from "@/lib/acp-runners/spawn-intent";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { runs, workspaces } = schemaModule as unknown as Record<string, any>;

// FIXME(any): dual drizzle-orm peer-dep variants.
type Db = any;

const log = pino({
  name: "run-resume",
  level: process.env.LOG_LEVEL ?? "info",
});

export type ResumeRunResult =
  | { ok: true; newSupervisorSessionId: string; acpSessionId: string }
  // [FIX] M8 review finding #3: distinct outcome for the lost-claim
  // race so /respond can map it to 202 (concurrent resume in progress)
  // instead of treating it as a terminal 410.
  | { ok: false; code: "CLAIM_RACE"; retryable: false; message: string }
  | { ok: false; code: MaisterErrorCode; retryable: boolean; message: string };

export type ResumeRunOptions = {
  db?: Db;
  recordSuccessAudit?: (db: Db) => Promise<void>;
};

// M8 T9 / D7: resume a NeedsInputIdle run by spawning a fresh
// supervisor session against the prior acpSessionId. All identifiers
// are server-state (D7 identifier table); body-controlled values are
// forbidden on the locator surface.
//
// On the success path: markResumed (NeedsInputIdle → NeedsInput +
// fresh keepalive_until + clear checkpoint_at) BEFORE returning.
// Resumes bypass the scheduler cap (D2): operator-driven, not
// auto-scheduled.
//
// Failure classification (D7 table):
//   supervisor 5xx / network → EXECUTOR_UNAVAILABLE, retryable, run stays NeedsInputIdle
//   supervisor 400         → CHECKPOINT, terminal, failResumedRun → Failed
//   201 empty acpSessionId  → CHECKPOINT, terminal, failResumedRun → Failed
//   supervisor 404         → CHECKPOINT, terminal, failResumedRun → Failed
export async function resumeRun(
  runId: string,
  opts: ResumeRunOptions = {},
): Promise<ResumeRunResult> {
  const db = opts.db ?? getDb();
  const startedAt = Date.now();

  const runRows = await db
    .select({
      id: runs.id,
      projectId: runs.projectId,
      status: runs.status,
      acpSessionId: runs.acpSessionId,
      currentStepId: runs.currentStepId,
      runnerSnapshot: runs.runnerSnapshot,
    })
    .from(runs)
    .where(eq(runs.id, runId));

  const runRow = runRows[0];

  if (!runRow) {
    log.warn({ runId }, "resumeRun: run not found");

    return {
      ok: false,
      code: "PRECONDITION",
      retryable: false,
      message: "run not found",
    };
  }

  if (runRow.status !== "NeedsInputIdle") {
    log.warn(
      { runId, status: runRow.status },
      "resumeRun: status guard mismatch — run is not NeedsInputIdle",
    );

    return {
      ok: false,
      code: "PRECONDITION",
      retryable: false,
      message: `run is ${runRow.status}, not NeedsInputIdle`,
    };
  }

  if (!runRow.acpSessionId) {
    log.error(
      { runId },
      "resumeRun: NeedsInputIdle run missing acpSessionId — failing terminally",
    );
    await failResumedRun(runId, "missing-acp-session-id", { db });

    return {
      ok: false,
      code: "CHECKPOINT",
      retryable: false,
      message: "missing acpSessionId on NeedsInputIdle run",
    };
  }

  if (!runRow.runnerSnapshot) {
    log.error({ runId }, "resumeRun: runner snapshot missing");
    await failResumedRun(runId, "runner-snapshot-missing", { db });

    return {
      ok: false,
      code: "CHECKPOINT",
      retryable: false,
      message: "runner snapshot missing",
    };
  }

  const wsRows = await db
    .select({
      projectSlug: workspaces.parentRepoPath,
      worktreePath: workspaces.worktreePath,
    })
    .from(workspaces)
    .where(eq(workspaces.runId, runId));
  const ws = wsRows[0];

  if (!ws) {
    log.error({ runId }, "resumeRun: workspace row missing");
    await failResumedRun(runId, "workspace-missing", { db });

    return {
      ok: false,
      code: "CHECKPOINT",
      retryable: false,
      message: "workspace row missing",
    };
  }

  const projRows = await db
    .select({ slug: schemaModule.projects.slug })
    .from(schemaModule.projects)
    .where(eq(schemaModule.projects.id, runRow.projectId));
  const projectSlug = projRows[0]?.slug;

  if (!projectSlug) {
    log.error(
      { runId, projectId: runRow.projectId },
      "resumeRun: project row missing",
    );
    await failResumedRun(runId, "project-missing", { db });

    return {
      ok: false,
      code: "CHECKPOINT",
      retryable: false,
      message: "project row missing",
    };
  }

  // [FIX] M8 review finding #3: atomic claim BEFORE spawning the
  // supervisor session. Two concurrent /respond retries serialize on
  // the markResumed CAS — exactly one wins. The loser sees the row in
  // NeedsInput and returns CLAIM_RACE so /respond can render 202
  // (concurrent resume in progress) instead of spawning a duplicate
  // worker and surfacing a misleading 410.
  const claim = await markResumed(runId, {
    db,
    ...(opts.recordSuccessAudit
      ? { recordSuccessAudit: opts.recordSuccessAudit }
      : {}),
  });

  if (!claim.ok) {
    log.warn(
      { runId },
      "[FIX] resumeRun: claim race lost — another /respond invocation owns the resume",
    );

    return {
      ok: false,
      code: "CLAIM_RACE",
      retryable: false,
      message: "concurrent resume in progress",
    };
  }

  try {
    const result = await createSession({
      runId,
      projectSlug,
      worktreePath: ws.worktreePath,
      stepId: runRow.currentStepId ?? "resume",
      executor: runnerExecutorInput(runRow.runnerSnapshot),
      runner: runnerSupervisorInput({ snapshot: runRow.runnerSnapshot }),
      resumeSessionId: runRow.acpSessionId,
      adapterLaunch: mergeRunnerAdapterLaunch(runRow.runnerSnapshot),
    });

    if (!result.acpSessionId) {
      log.error(
        { runId, supervisorSessionId: result.sessionId },
        "resumeRun: supervisor returned empty acpSessionId — failing terminally",
      );
      await failResumedRun(runId, "supervisor-empty-acp-session", { db });

      return {
        ok: false,
        code: "CHECKPOINT",
        retryable: false,
        message: "supervisor 201 missing acpSessionId",
      };
    }

    log.info(
      {
        runId,
        acpSessionId: runRow.acpSessionId,
        newSupervisorSessionId: result.sessionId,
        latencyMs: Date.now() - startedAt,
      },
      "resumeRun success",
    );

    return {
      ok: true,
      newSupervisorSessionId: result.sessionId,
      acpSessionId: result.acpSessionId,
    };
  } catch (err) {
    if (isMaisterError(err)) {
      if (err.code === "EXECUTOR_UNAVAILABLE") {
        // [FIX] Retryable spawn failure — roll back the claim so the
        // next /respond (or the next sweeper tick) sees the row in
        // NeedsInputIdle again. Without the rollback the row would
        // stay in NeedsInput indefinitely with no live worker — a
        // permanent split-brain.
        log.warn(
          { runId, err: err.message },
          "[FIX] resumeRun: supervisor 5xx — rolling back claim and returning retryable",
        );
        await rollbackResumedRun(runId, { db });

        return {
          ok: false,
          code: "EXECUTOR_UNAVAILABLE",
          retryable: true,
          message: err.message,
        };
      }

      // PRECONDITION (404 from supervisor on resume), CHECKPOINT, ACP_PROTOCOL,
      // SPAWN, CRASH — all terminal for the resume attempt; mark Failed.
      log.warn(
        { runId, code: err.code, err: err.message },
        "resumeRun: supervisor non-retryable error — failing terminally",
      );
      await failResumedRun(runId, `supervisor-${err.code}`, { db });

      return {
        ok: false,
        code: "CHECKPOINT",
        retryable: false,
        message: err.message,
      };
    }

    log.error(
      { runId, err: err instanceof Error ? err.message : String(err) },
      "resumeRun: unknown error — failing terminally",
    );
    await failResumedRun(runId, "unknown-error", { db });

    throw new MaisterError(
      "CHECKPOINT",
      `resumeRun(${runId}): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
