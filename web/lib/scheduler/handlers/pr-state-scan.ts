import "server-only";

import type { Provider } from "@/lib/repo-source";
import type { PrStateReadResult } from "@/lib/runs/pr-adapter";

import { sql, type SQL } from "drizzle-orm";
import pino from "pino";

import { getDb } from "@/lib/db/client";
import { MaisterError } from "@/lib/errors";
import { detectProvider, readRemoteOrigin } from "@/lib/repo-source";
import {
  getPrState as defaultGetPrState,
  EXEC_TIMEOUT_MS,
} from "@/lib/runs/pr-adapter";
import {
  prStateScanJobId,
  schedulerAttemptTimeoutSeconds,
} from "@/lib/scheduler/jobs";
import { recordTaskActivity } from "@/lib/social/activity";
import { emitWebhookEvent } from "@/lib/webhooks/outbox";

// One bounded batch per tick; the durable keyset cursor (this job's
// `target->'cursor'`) paginates the rest through the partial candidate index.
const PR_STATE_SCAN_BATCH = 50;

// The per-provider-call ceiling the adapters actually enforce. Imported, not
// mirrored: this reserves it as lease headroom, so a copy that drifts below the
// adapter's real timeout lets a candidate started just under the deadline outlive
// the lease and be reaped mid-call.
const PR_STATE_SCAN_CALL_BUDGET_MS = EXEC_TIMEOUT_MS;

// How long this handler may keep STARTING candidates before it must stop and let
// the cursor resume next tick. Derived from the ACTUAL scheduler lease (the same
// env-tunable value the reaper uses) so the two can never drift apart: reserve
// one worst-case provider call plus a margin for the cursor write, because a
// candidate started just under the deadline may still burn its full budget.
// Deliberately UNFLOORED, and may go non-positive: a lease too short to fit one
// worst-case provider call must start ZERO candidates (the loop's deadline guard
// then breaks on the first iteration and the cursor holds), never the one it
// cannot finish. A floor would license exactly that — the attempt gets reaped as
// LEASE_EXPIRED while the call is still writing, and the replacement scan runs
// unfenced against the same rows.
function scanBudgetMs(): number {
  const leaseMs = schedulerAttemptTimeoutSeconds() * 1_000;

  return leaseMs - PR_STATE_SCAN_CALL_BUDGET_MS - 10_000;
}

const log = pino({
  name: "pr-state-scan",
  level: process.env.LOG_LEVEL ?? "info",
});

type QueryResult = { rows?: unknown[] };

type PrStateScanDb = {
  execute(query: SQL): Promise<QueryResult>;
  transaction<T>(transaction: (tx: PrStateScanDb) => Promise<T>): Promise<T>;
  // Declared because `recordTaskActivity` — the ONLY task_activity writer — is a
  // query-builder call, so this seam must carry it rather than raw SQL.
  // FIXME(any): dual drizzle-orm peer-dep variants (matches lib/social/activity.ts).
  insert: any;
};

type GetPrStateFn = typeof defaultGetPrState;

type ProjectRow = {
  id: string;
  repo_url: string | null;
  repo_path: string;
};

type CandidateRow = {
  id: string;
  pr_number: number;
  pr_url: string | null;
  run_id: string;
  task_id: string | null;
};

type PrState = Extract<PrStateReadResult, { kind: "state" }>;

type CandidateOutcome = "updated" | "skipped" | "stamped";

export type PrStateScanSummary = {
  scanned: number;
  updated: number;
  skipped: number;
  failed?: number;
  cursor: string | null;
  reason?: string;
};

// ADR-140: the per-project PR-state poll. A pure provider-read + DB job — it
// NEVER spawns a session, mutates git, or writes `runs.merge_commit_sha` (that
// column stays owned by repo_delivery_scan). It applies three edge-guarded,
// exactly-once state transitions, and writes state ONLY from a successful read.
// The durable keyset cursor is what bounds a bad row: it advances past anything
// that fails, so no row can stall the per-project job.
export async function runPrStateScanJob(input: {
  projectId: string | null;
  now?: Date;
  db?: PrStateScanDb;
  getPrState?: GetPrStateFn;
}): Promise<PrStateScanSummary> {
  if (!input.projectId) {
    throw new MaisterError(
      "PRECONDITION",
      "pr_state_scan job requires a project_id",
    );
  }

  const projectId = input.projectId;
  const db = input.db ?? (getDb() as unknown as PrStateScanDb);
  const getPrState = input.getPrState ?? defaultGetPrState;
  const project = await loadProject(db, projectId);

  const remoteUrl =
    project.repo_url ?? (await readRemoteOrigin(project.repo_path));

  // A missing remote is a project-scoped scanner failure (Failed → consumes the
  // bounded retry budget), NOT a harmless skip — the tick catch is wired to
  // treat pr_state_scan PRECONDITION as Failed.
  if (!remoteUrl) {
    throw new MaisterError(
      "PRECONDITION",
      `pr_state_scan origin remote is not configured: ${projectId}`,
    );
  }

  const provider = detectProvider(remoteUrl);
  const cursor = await readCursor(db, projectId);
  const candidates = await loadCandidates(db, projectId, cursor);

  // A generic remote has no PR-state API (getPrState would only ever return
  // `unsupported`). Never loop or stamp — a generic project carries no PR
  // tracking, so its candidate rows must not be touched.
  if (provider === "generic") {
    log.info(
      { projectId, candidateCount: candidates.length },
      "pr state scan skipped — unsupported provider",
    );

    return {
      scanned: 0,
      updated: 0,
      skipped: candidates.length,
      cursor,
      reason: "unsupported_provider",
    };
  }

  let updated = 0;
  let skipped = 0;
  let failed = 0;
  let lastProcessedId: string | null = null;
  let deadlineHit = false;
  const deadline = Date.now() + scanBudgetMs();

  // The cursor must name the last candidate we VISITED, never the window end —
  // advancing past unvisited rows would silently skip them until the cursor
  // wrapped. On a deadline stop we resume exactly where we left off (and hold
  // the incoming cursor if we visited nothing at all).
  // Otherwise: a full window advances; a short (tail) batch resets so the next
  // tick wraps to the head — every candidate is visited within ceil(N / batch)
  // ticks regardless of never-moving rows. THIS is the mechanism that keeps one
  // bad row from stalling the job.
  const nextCursorNow = (): string | null =>
    deadlineHit || failed > 0
      ? (lastProcessedId ?? cursor)
      : candidates.length === PR_STATE_SCAN_BATCH
        ? candidates[candidates.length - 1].id
        : null;

  try {
    for (const candidate of candidates) {
      // Never START a candidate we cannot finish inside the lease. A full batch of
      // slow providers (50 × the adapter's 60s budget) would otherwise run ~10x
      // past the lease: the scheduler would reap this attempt as LEASE_EXPIRED and
      // start a REPLACEMENT scan while this one is still writing — two unfenced
      // scanners on the same rows, and enough repeated failures to disable the job.
      if (Date.now() >= deadline) {
        deadlineHit = true;
        break;
      }

      try {
        const outcome = await processCandidate({
          db,
          getPrState,
          provider,
          remoteUrl,
          projectId,
          candidate,
        });

        if (outcome === "updated") updated += 1;
        else if (outcome === "skipped") skipped += 1;
      } catch (err) {
        // One poison row may not take the scan down with it. Letting it throw
        // would abandon the cursor write, reload the identical window next tick,
        // throw again, and after max_failures DISABLE the job — which
        // `ensurePrStateScanJobs` only re-enables while
        // `consecutive_failures < max_failures`, i.e. never again.
        failed += 1;
        log.error(
          {
            projectId,
            prNumber: candidate.pr_number,
            err: err instanceof Error ? err.message : String(err),
          },
          "pr state candidate failed — advancing the cursor past it",
        );
      }

      lastProcessedId = candidate.id;
    }
  } finally {
    // Always durable, even on an unexpected throw: an abandoned cursor is what
    // turns a single bad row into permanently dead PR tracking.
    await writeCursor(db, projectId, nextCursorNow());
  }

  const nextCursor = nextCursorNow();

  if (deadlineHit) {
    log.warn(
      {
        projectId,
        scanned: candidates.length,
        processed: (updated + skipped) as number,
        cursor: nextCursor,
      },
      "[FIX:ADR-140] pr state scan stopped at its lease budget — resuming from the cursor next tick",
    );
  }

  const summary: PrStateScanSummary = {
    scanned: candidates.length,
    updated,
    skipped,
    failed,
    cursor: nextCursor,
  };

  log.info({ projectId, ...summary }, "pr state scan complete");

  return summary;
}

async function loadProject(
  db: PrStateScanDb,
  projectId: string,
): Promise<ProjectRow> {
  const project = rowsOf<ProjectRow>(
    await db.execute(sql`
      SELECT id, repo_url, repo_path
      FROM projects
      WHERE id = ${projectId}
      LIMIT 1
    `),
  )[0];

  if (!project) {
    throw new MaisterError(
      "PRECONDITION",
      `pr_state_scan project does not exist: ${projectId}`,
    );
  }

  return project;
}

async function loadCandidates(
  db: PrStateScanDb,
  projectId: string,
  cursor: string | null,
): Promise<CandidateRow[]> {
  return rowsOf<CandidateRow>(
    await db.execute(sql`
      SELECT
        w.id AS id,
        w.pr_number AS pr_number,
        w.pr_url AS pr_url,
        r.id AS run_id,
        r.task_id AS task_id
      FROM workspaces w
      INNER JOIN runs r ON r.id = w.run_id
      WHERE w.project_id = ${projectId}
        AND w.pr_url IS NOT NULL
        AND (w.pr_state IS NULL OR w.pr_state = 'open')
        AND r.run_kind <> 'scratch'
        AND (${cursor}::text IS NULL OR w.id > ${cursor})
      ORDER BY w.id ASC
      LIMIT ${PR_STATE_SCAN_BATCH}
    `),
  );
}

async function processCandidate(args: {
  db: PrStateScanDb;
  getPrState: GetPrStateFn;
  provider: Provider;
  remoteUrl: string;
  projectId: string;
  candidate: CandidateRow;
}): Promise<CandidateOutcome> {
  const { db, getPrState, provider, remoteUrl, projectId, candidate } = args;
  const result = await getPrState({
    provider,
    remoteUrl,
    prNumber: candidate.pr_number,
  });

  if (result.kind === "skip") {
    // A FAILED READ NEVER WRITES `pr_state`. Providers answer permission-denied
    // with the same 404/"could not resolve" they use for a deleted PR, so this
    // path cannot tell "deleted" from "the token lost access" — and `pr_state`
    // has no writer that could later undo a wrong `closed` (loadCandidates only
    // selects NULL/'open', so the row would never be re-read). Leaving the state
    // untouched costs one re-read per cursor cycle; guessing 'closed' costs a
    // silently untracked live PR and a refused reopen. The CURSOR — not any
    // per-row stamp — is what keeps one bad row from stalling the job.
    log.warn(
      {
        projectId,
        prNumber: candidate.pr_number,
        transient: result.transient,
        reason: result.reason,
      },
      "pr state candidate skipped",
    );

    return "skipped";
  }

  // Defensive — step 1 already returns early for a generic provider, so a live
  // `unsupported` should not reach here.
  if (result.kind === "unsupported") {
    return "skipped";
  }

  return applyStateEdges({ db, projectId, candidate, state: result });
}

async function applyStateEdges(args: {
  db: PrStateScanDb;
  projectId: string;
  candidate: CandidateRow;
  state: PrState;
}): Promise<CandidateOutcome> {
  const { db, projectId, candidate, state } = args;
  let changed = false;

  // A TERMINAL PR (merged/closed) has no meaningful mergeability, and providers
  // report it as unknown (`hasConflicts: null`) — which the "leave as-is" rule
  // below would turn into a STALE `true` surviving from the PR's open days. That
  // stale flag is load-bearing: reopen eligibility accepts a conflicted PR, so a
  // closed PR would qualify, and re-promotion's `createOrUpdatePr` is
  // open-PR-only — it would silently open a SECOND PR, breaking the
  // "re-promotion MUST reuse the SAME provider PR" expectation
  // (docs/system-analytics/branch-sync.md). Terminal ⇒ no conflicts, always.
  const terminalPr = state.state === "merged" || state.state === "closed";

  // Conflicts edge — independent of the state edge (a still-open PR can gain a
  // conflict). The guard is the PREVIOUS column value so a re-scan is
  // exactly-once.
  if (state.hasConflicts === true && !terminalPr) {
    changed = await conflictsEdge({ db, projectId, candidate });
  } else if (state.hasConflicts === false || terminalPr) {
    // Silent clear — no webhook. Guarded on the previous value like every other
    // edge, so a re-scan of an already-clear row is a no-op rather than a write.
    // (This does NOT fence a clear against a CONCURRENT scanner's alarm: the
    // guard is evaluated against the row as it is NOW, not as it was when this
    // tick read the provider.)
    await db.execute(sql`
      UPDATE workspaces
      SET pr_has_conflicts = false
      WHERE id = ${candidate.id}
        AND pr_has_conflicts IS DISTINCT FROM false
    `);
  }
  // hasConflicts === null on a still-OPEN PR → leave as-is (unknown ≠ resolved).

  // State edge — merged / closed / open, mutually exclusive.
  if (state.state === "merged") {
    changed =
      (await mergedEdge({ db, projectId, candidate, state })) || changed;
  } else if (state.state === "closed") {
    changed = (await closedEdge({ db, projectId, candidate })) || changed;
  }
  // open — nothing to write; the row stays in the candidate set.

  return changed ? "updated" : "stamped";
}

async function conflictsEdge(args: {
  db: PrStateScanDb;
  projectId: string;
  candidate: CandidateRow;
}): Promise<boolean> {
  const { db, projectId, candidate } = args;

  return db.transaction(async (tx) => {
    const fired =
      rowsOf(
        await tx.execute(sql`
          UPDATE workspaces
          SET pr_has_conflicts = true
          WHERE id = ${candidate.id}
            AND (pr_has_conflicts IS NULL OR pr_has_conflicts = false)
          RETURNING id
        `),
      ).length > 0;

    if (fired) {
      await emitWebhookEvent({
        db: tx,
        type: "run.pr_conflicts",
        projectId,
        runId: candidate.run_id,
        data: { prNumber: candidate.pr_number, prUrl: candidate.pr_url },
      });
    }

    return fired;
  });
}

async function mergedEdge(args: {
  db: PrStateScanDb;
  projectId: string;
  candidate: CandidateRow;
  state: PrState;
}): Promise<boolean> {
  const { db, projectId, candidate, state } = args;

  return db.transaction(async (tx) => {
    const fired =
      rowsOf(
        await tx.execute(sql`
          UPDATE workspaces
          SET
            pr_state = 'merged',
            pr_merged_at = ${state.mergedAt}::timestamptz,
            pr_merge_commit_sha = ${state.mergeCommitSha}
          WHERE id = ${candidate.id}
            AND (pr_state IS NULL OR pr_state = 'open')
          RETURNING id
        `),
      ).length > 0;

    if (fired) {
      await emitWebhookEvent({
        db: tx,
        type: "run.pr_merged",
        projectId,
        runId: candidate.run_id,
        data: {
          prNumber: candidate.pr_number,
          prUrl: candidate.pr_url,
          mergeCommitSha: state.mergeCommitSha,
        },
      });

      if (candidate.task_id) {
        await recordTaskActivity(tx, {
          taskId: candidate.task_id,
          projectId,
          actor: { type: "system", id: null },
          eventKind: "run_pr_merged",
          payload: { prNumber: candidate.pr_number },
        });
      }
    }

    return fired;
  });
}

async function closedEdge(args: {
  db: PrStateScanDb;
  projectId: string;
  candidate: CandidateRow;
}): Promise<boolean> {
  const { db, projectId, candidate } = args;

  return db.transaction(async (tx) => {
    const fired =
      rowsOf(
        await tx.execute(sql`
          UPDATE workspaces
          SET pr_state = 'closed'
          WHERE id = ${candidate.id}
            AND (pr_state IS NULL OR pr_state = 'open')
          RETURNING id
        `),
      ).length > 0;

    if (fired) {
      await emitWebhookEvent({
        db: tx,
        type: "run.pr_closed",
        projectId,
        runId: candidate.run_id,
        data: { prNumber: candidate.pr_number, prUrl: candidate.pr_url },
      });
    }

    return fired;
  });
}

async function readCursor(
  db: PrStateScanDb,
  projectId: string,
): Promise<string | null> {
  const raw =
    rowsOf<{ cursor: unknown }>(
      await db.execute(sql`
        SELECT target -> 'cursor' AS cursor
        FROM scheduler_jobs
        WHERE id = ${prStateScanJobId(projectId)}
      `),
    )[0]?.cursor ?? null;

  return typeof raw === "string" ? raw : null;
}

async function writeCursor(
  db: PrStateScanDb,
  projectId: string,
  cursor: string | null,
): Promise<void> {
  await db.execute(sql`
    UPDATE scheduler_jobs
    SET target = jsonb_set(
      coalesce(target, '{}'::jsonb),
      '{cursor}',
      ${JSON.stringify(cursor)}::jsonb,
      true
    )
    WHERE id = ${prStateScanJobId(projectId)}
  `);
}

function rowsOf<T>(result: QueryResult): T[] {
  return (result.rows ?? []) as T[];
}
