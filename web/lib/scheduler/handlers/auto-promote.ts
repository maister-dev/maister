import "server-only";

import type { PromotionHold } from "@/lib/auto-promotion/types";

import { and, eq, isNotNull, isNull, ne, sql } from "drizzle-orm";
import pino from "pino";

import { autoPromotionEnabledFromEnv } from "@/lib/auto-promotion/config";
import {
  evaluateAutoPromotion,
  type AutoPromotionEvaluation,
  type AutoPromotionRunView,
} from "@/lib/auto-promotion/evaluate";
import { buildAutoPromotionReaders } from "@/lib/auto-promotion/readers";
import { getDb } from "@/lib/db/client";
import { projects, runs, workspaces } from "@/lib/db/schema";
import { isMaisterError } from "@/lib/errors";
import { promoteRun, type PromoteRunContext } from "@/lib/runs/promote";
import { DEFAULT_AUTO_PROMOTE_JOB_ID } from "@/lib/scheduler/jobs";
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

export const CANDIDATE_LIMIT = 20;

export type AutoPromoteSummary = {
  candidates: number;
  promoted: number;
  skipped: number;
  gaveUp: number;
};

// Rotation cursor: the (coalesced review anchor, run id) key of the last row the
// previous tick processed. `sortKey` is an ISO timestamp, or the literal
// "infinity" for a null review anchor (matching the ORDER BY's coalesce).
type AutoPromoteCursor = { sortKey: string; id: string };

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

  // Durable rotating keyset cursor (ADR-126 / Codex F1): process a bounded
  // CANDIDATE_LIMIT window per tick, ordered by a stable key, resuming after the
  // previous tick's last row and wrapping at the tail. Without it, an unordered
  // LIMIT plus never-mutated permanent-skip rows (deny_list / no_lane / ambiguous
  // / checks_not_strict / disabled-project, …) could wedge the window and starve
  // an eligible run indefinitely. Persisted in this singleton job's `target`
  // jsonb; an absent row (unit tests) reads as null ⇒ start from the head.
  const cursor = await readAutoPromoteCursor(db);

  // Full config/enabled + all predicate terms are re-checked in
  // evaluateAutoPromotion per candidate; the SQL here only prefilters + orders.
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
        // ADR-140 (Task 12): a reopened Done run must be re-promoted MANUALLY —
        // never auto-promoted by a lane the instant it returns to Review.
        ne(workspaces.promotionState, "reopened"),
        isNull(runs.promotionHold),
        // Master toggle pushed into SQL so a configured-but-disabled project never
        // occupies a candidate slot (evaluateAutoPromotion still re-checks it).
        // JSONB containment, NOT a `->> ::boolean` cast: a malformed stored value
        // (e.g. {"enabled":"x"}) must not throw a Postgres cast error and crash the
        // singleton sweep — resolveAutoPromotionConfig (→ config_invalid) is the
        // fail-closed authority.
        sql`${projects.autoPromotion} @> '{"enabled": true}'::jsonb`,
        // A shared-tree run has workspace_mode='shared'; exclude fail-closed.
        sql`${runs.workspaceMode} IS DISTINCT FROM 'shared'`,
        // ADR-132 (enforcing ADR-124): experiment member runs never occupy a
        // candidate slot — winner promotion is the explicit human path.
        // evaluateAutoPromotion re-checks membership at the apply site.
        sql`NOT EXISTS (SELECT 1 FROM experiment_runs er WHERE er.run_id = ${runs.id})`,
        // Keyset resume: rows strictly after the previous tick's last key, in the
        // ORDER BY's (coalesced review anchor, id) space.
        cursor
          ? sql`(coalesce(${runs.reviewEnteredAt}, 'infinity'::timestamptz), ${runs.id}) > (${cursor.sortKey}::timestamptz, ${cursor.id})`
          : undefined,
      ),
    )
    .orderBy(
      sql`coalesce(${runs.reviewEnteredAt}, 'infinity'::timestamptz) asc, ${runs.id} asc`,
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

  // Advance past the processed window, or reset to wrap when a short (tail) window
  // is reached — guarantees every candidate is visited within
  // ceil(N / CANDIDATE_LIMIT) ticks regardless of never-mutated permanent skips.
  const last = candidates[candidates.length - 1];
  const nextCursor: AutoPromoteCursor | null =
    last && candidates.length === CANDIDATE_LIMIT
      ? {
          sortKey: last.reviewEnteredAt
            ? last.reviewEnteredAt.toISOString()
            : "infinity",
          id: last.runId,
        }
      : null;

  await writeAutoPromoteCursor(db, nextCursor);

  log.info(summary, "auto-promotion sweep complete");

  return summary;
}

// Cursor read/write target the seeded singleton row by its known id; an absent
// row (the direct-call unit tests DELETE scheduler_jobs) reads null / no-ops the
// write, so the sweep degrades to head-start with no persistence.
async function readAutoPromoteCursor(
  db: Db,
): Promise<AutoPromoteCursor | null> {
  const res = await db.execute(
    sql`SELECT target -> 'cursor' AS cursor FROM scheduler_jobs WHERE id = ${DEFAULT_AUTO_PROMOTE_JOB_ID}`,
  );
  const raw = (res.rows?.[0]?.cursor ??
    null) as Partial<AutoPromoteCursor> | null;

  return raw && typeof raw.sortKey === "string" && typeof raw.id === "string"
    ? { sortKey: raw.sortKey, id: raw.id }
    : null;
}

async function writeAutoPromoteCursor(
  db: Db,
  cursor: AutoPromoteCursor | null,
): Promise<void> {
  await db.execute(sql`
    UPDATE scheduler_jobs
    SET target = jsonb_set(coalesce(target, '{}'::jsonb), '{cursor}', ${JSON.stringify(
      cursor,
    )}::jsonb, true)
    WHERE id = ${DEFAULT_AUTO_PROMOTE_JOB_ID}
  `);
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
  const {
    db,
    promote,
    runId,
    projectId,
    taskId,
    evaluation,
    fileCount,
    summary,
  } = args;
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
  } catch (err) {
    // Superseded (a user hold or project lane-disable landed under the promote
    // claim, ADR-126): benign — the run is intentionally no longer
    // auto-promotable. No system hold, no give-up comment; next tick's prefilter
    // excludes it. Keyed on `details`, NOT code, so a real git merge CONFLICT
    // still routes to the give-up path below.
    if (isMaisterError(err) && err.details?.autoPromotionSuperseded) {
      summary.skipped += 1;
      log.info(
        { runId, supersededBy: err.details.autoPromotionSuperseded },
        "auto-promotion superseded — skip",
      );

      return;
    }

    const code = isMaisterError(err) ? err.code : "CRASH";

    // Transient: leave the run in Review, retry next tick (no hold, no comment).
    if (code === "EXECUTOR_UNAVAILABLE") {
      summary.skipped += 1;
      log.warn({ runId, code }, "auto-promotion transient — retry next tick");

      return;
    }

    // Terminal failure. Only stamp a give-up hold when the run is STILL Review: a
    // sweep-vs-human race loser fails CONFLICT/PRECONDITION AFTER the human winner
    // moved the run to Done, and must NOT get a false give-up hold/comment.
    // holdAndComment CASes on (promotion_hold IS NULL AND status='Review') and
    // reports whether it actually held (Codex R2-F2).
    const reason = `auto-promotion gave up (${code}): ${
      err instanceof Error ? err.message : String(err)
    }`;
    const held = await holdAndComment({ db, runId, taskId, reason });

    if (held) {
      summary.gaveUp += 1;
      log.info({ runId, code }, "auto-promotion gave up — held");
    } else {
      summary.skipped += 1;
      log.warn(
        { runId, code },
        "auto-promotion failed but run no longer Review — skip (race loss)",
      );
    }

    return;
  }

  // Success. The audit comment is best-effort and lives OUTSIDE the promote try so
  // a comment failure on an already-promoted (Done) run can never route to the
  // give-up path above (Codex R2-F2).
  summary.promoted += 1;
  log.info({ runId, lane, fileCount }, "auto-promoted");

  if (taskId) {
    try {
      await addTaskComment(
        {
          taskId,
          body: `Auto-promoted via the \`${lane}\` lane — ${fileCount} file(s), readiness ✓ · /runs/${runId}`,
          actor: { type: "system", id: null },
        },
        db,
      );
    } catch (err) {
      log.warn(
        { runId, err: err instanceof Error ? err.message : String(err) },
        "auto-promotion succeeded but the audit comment failed",
      );
    }
  }
}

async function holdAndComment(args: {
  db: Db;
  runId: string;
  taskId: string | null;
  reason: string;
}): Promise<boolean> {
  const { db, runId, taskId, reason } = args;
  const hold: PromotionHold = {
    source: "system",
    reason,
    createdAt: new Date().toISOString(),
  };

  return db.transaction(async (tx: Db) => {
    // CAS on status='Review' too (Codex R2-F2): a run a human/other winner already
    // moved past Review must not receive a false give-up hold. The status+hold CAS
    // also proves at-most-one comment across retries.
    const held = await tx
      .update(runs)
      .set({ promotionHold: hold })
      .where(
        and(
          eq(runs.id, runId),
          isNull(runs.promotionHold),
          eq(runs.status, "Review"),
        ),
      )
      .returning({ id: runs.id });

    if (held.length > 0 && taskId) {
      await addTaskComment(
        { taskId, body: reason, actor: { type: "system", id: null } },
        tx,
      );
    }

    return held.length > 0;
  });
}
