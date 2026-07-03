import "server-only";

import { and, eq, isNotNull, isNull, ne, sql } from "drizzle-orm";
import pino from "pino";

import { autoPromotionEnabledFromEnv } from "@/lib/auto-promotion/config";
import {
  evaluateAutoPromotion,
  type AutoPromotionEvaluation,
  type AutoPromotionRunView,
} from "@/lib/auto-promotion/evaluate";
import { buildAutoPromotionReaders } from "@/lib/auto-promotion/readers";
import type { PromotionHold } from "@/lib/auto-promotion/types";
import { getDb } from "@/lib/db/client";
import { projects, runs, workspaces } from "@/lib/db/schema";
import { isMaisterError } from "@/lib/errors";
import { promoteRun, type PromoteRunContext } from "@/lib/runs/promote";
import { addTaskComment } from "@/lib/social/comments";
import { diffChangeStats, type DiffChangeStatEntry } from "@/lib/worktree";

// FIXME(any): route + tests pass a minimal drizzle-like fake / a Testcontainers
// pg client; both expose select/update/transaction.
type Db = any;

type PromoteFn = typeof promoteRun;

const log = pino({
  name: "auto-promote",
  level: process.env.LOG_LEVEL ?? "info",
});

const CANDIDATE_LIMIT = 20;

export type AutoPromoteSummary = {
  candidates: number;
  promoted: number;
  skipped: number;
  gaveUp: number;
};

// Non-user promote ctx (ADR-126 §4.6), mirroring promoteChildRunForToken: a
// placeholder sessionUser that is never dereferenced for a system actor, a no-op
// authorize, and actor.kind='system' (owner-less promotion, conflict → typed
// CONFLICT rather than a human merge-conflict assignment).
function systemPromoteCtx(projectId: string): PromoteRunContext {
  return {
    sessionUser: { id: `auto-promotion:${projectId}` },
    authorize: async () => undefined,
    actor: { kind: "system" },
  };
}

// The ADR-126 auto-promotion sweep: a systemManaged, budget-1, 60s singleton
// that promotes lane-bounded Review flow runs through the SAME promoteRun choke
// point. Injectable `promote`/`db`/`now` for the through-dispatch + AC tests.
export async function runAutoPromoteJob(
  opts: { db?: Db; promote?: PromoteFn; now?: Date } = {},
): Promise<AutoPromoteSummary> {
  const summary: AutoPromoteSummary = {
    candidates: 0,
    promoted: 0,
    skipped: 0,
    gaveUp: 0,
  };

  // Within-one-tick kill switch (env off between ticks stops NEW promotions).
  if (!autoPromotionEnabledFromEnv()) {
    log.debug({}, "auto-promotion disabled by env — skipping tick");

    return summary;
  }

  const db = opts.db ?? getDb();
  const promote = opts.promote ?? promoteRun;
  const now = opts.now ?? new Date();

  // Cheap SQL prefilter; full config/enabled + all predicate terms re-checked in
  // evaluateAutoPromotion per candidate (a lane disabled between ticks is re-read
  // here — edge E4).
  const candidates = await db
    .select({
      runId: runs.id,
      projectId: runs.projectId,
      status: runs.status,
      runKind: runs.runKind,
      taskId: runs.taskId,
      parentRunId: runs.parentRunId,
      workspaceMode: runs.workspaceMode,
      deliveryPolicySnapshot: runs.deliveryPolicySnapshot,
      executionPolicy: runs.executionPolicy,
      promotionHold: runs.promotionHold,
      reviewEnteredAt: runs.reviewEnteredAt,
      autoPromotion: projects.autoPromotion,
      worktreePath: workspaces.worktreePath,
      branch: workspaces.branch,
      baseCommit: workspaces.baseCommit,
    })
    .from(runs)
    .innerJoin(workspaces, eq(workspaces.runId, runs.id))
    .innerJoin(projects, eq(projects.id, runs.projectId))
    .where(
      and(
        eq(runs.status, "Review"),
        eq(runs.runKind, "flow"),
        isNotNull(runs.taskId),
        isNull(runs.parentRunId),
        ne(workspaces.promotionState, "done"),
        isNull(runs.promotionHold),
        isNotNull(projects.autoPromotion),
        // A shared-tree run has workspace_mode='shared'; exclude fail-closed.
        sql`${runs.workspaceMode} IS DISTINCT FROM 'shared'`,
      ),
    )
    .limit(CANDIDATE_LIMIT);

  summary.candidates = candidates.length;

  for (const c of candidates) {
    if (!c.baseCommit) {
      summary.skipped += 1;
      log.debug({ runId: c.runId }, "no base commit — skip");
      continue;
    }

    let files: DiffChangeStatEntry[];

    try {
      files = await diffChangeStats({
        worktreePath: c.worktreePath,
        baseRef: c.baseCommit,
        branch: c.branch,
      });
    } catch (err) {
      summary.skipped += 1;
      log.warn({ runId: c.runId, err: String(err) }, "diff failed — skip");
      continue;
    }

    const run: AutoPromotionRunView = {
      id: c.runId,
      projectId: c.projectId,
      status: c.status,
      runKind: c.runKind,
      taskId: c.taskId,
      parentRunId: c.parentRunId,
      workspaceMode: c.workspaceMode,
      deliveryPolicySnapshot: c.deliveryPolicySnapshot,
      executionPolicy: c.executionPolicy,
      promotionHold: c.promotionHold,
      reviewEnteredAt: c.reviewEnteredAt,
    };

    const evaluation = await evaluateAutoPromotion({
      run,
      project: { id: c.projectId, autoPromotion: c.autoPromotion },
      files,
      now,
      readers: buildAutoPromotionReaders({
        db,
        runId: c.runId,
        worktreePath: c.worktreePath,
        baseRef: c.baseCommit,
        branch: c.branch,
      }),
    });

    log.debug(
      { runId: c.runId, verdict: evaluation.verdict },
      "auto-promotion candidate evaluated",
    );

    if (evaluation.verdict !== "eligible") {
      summary.skipped += 1;
      continue;
    }

    await promoteCandidate({
      db,
      promote,
      runId: c.runId,
      projectId: c.projectId,
      taskId: c.taskId,
      evaluation,
      fileCount: files.length,
      summary,
    });
  }

  log.info(summary, "auto-promotion sweep complete");

  return summary;
}

async function promoteCandidate(args: {
  db: Db;
  promote: PromoteFn;
  runId: string;
  projectId: string;
  taskId: string | null;
  evaluation: Extract<AutoPromotionEvaluation, { verdict: "eligible" }>;
  fileCount: number;
  summary: AutoPromoteSummary;
}): Promise<void> {
  const { db, promote, runId, projectId, taskId, evaluation, fileCount, summary } =
    args;
  const lane = evaluation.lane;

  try {
    await promote(
      runId,
      {
        autoOnReady: true,
        mode: evaluation.mode,
        attribution: { source: "auto_promotion", laneClass: lane },
      },
      systemPromoteCtx(projectId),
      db,
    );

    summary.promoted += 1;
    log.info({ runId, lane, fileCount }, "auto-promoted");

    if (taskId) {
      await addTaskComment(
        {
          taskId,
          body: `Auto-promoted via the \`${lane}\` lane — ${fileCount} file(s), readiness ✓ · /runs/${runId}`,
          actor: { type: "system", id: null },
        },
        db,
      );
    }
  } catch (err) {
    const code = isMaisterError(err) ? err.code : "CRASH";

    // Transient: leave the run in Review, retry next tick (no hold, no comment).
    if (code === "EXECUTOR_UNAVAILABLE") {
      summary.skipped += 1;
      log.warn({ runId, code }, "auto-promotion transient — retry next tick");

      return;
    }

    // Terminal give-up (CONFLICT / PRECONDITION / CONFIG): one-tx CAS hold +
    // exactly-one comment (the CAS proves at-most-one).
    const reason = `auto-promotion gave up (${code}): ${
      err instanceof Error ? err.message : String(err)
    }`;

    summary.gaveUp += 1;
    await holdAndComment({ db, runId, taskId, reason });
    log.info({ runId, code }, "auto-promotion gave up — held");
  }
}

async function holdAndComment(args: {
  db: Db;
  runId: string;
  taskId: string | null;
  reason: string;
}): Promise<void> {
  const { db, runId, taskId, reason } = args;
  const hold: PromotionHold = {
    source: "system",
    reason,
    createdAt: new Date().toISOString(),
  };

  await db.transaction(async (tx: Db) => {
    const held = await tx
      .update(runs)
      .set({ promotionHold: hold })
      .where(and(eq(runs.id, runId), isNull(runs.promotionHold)))
      .returning({ id: runs.id });

    // Only the CAS winner posts the comment ⇒ exactly-one comment across retries.
    if (held.length > 0 && taskId) {
      await addTaskComment(
        { taskId, body: reason, actor: { type: "system", id: null } },
        tx,
      );
    }
  });
}
