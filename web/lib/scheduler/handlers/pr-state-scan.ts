import "server-only";

import type { Provider } from "@/lib/repo-source";
import type { PrStateReadResult } from "@/lib/runs/pr-adapter";

import { randomUUID } from "node:crypto";

import { sql, type SQL } from "drizzle-orm";
import pino from "pino";

import { getDb } from "@/lib/db/client";
import { MaisterError } from "@/lib/errors";
import { detectProvider, readRemoteOrigin } from "@/lib/repo-source";
import { getPrState as defaultGetPrState } from "@/lib/runs/pr-adapter";
import { prStateScanJobId } from "@/lib/scheduler/jobs";
import { emitWebhookEvent } from "@/lib/webhooks/outbox";

// One bounded batch per tick; the durable keyset cursor (this job's
// `target->'cursor'`) paginates the rest through the partial candidate index.
const PR_STATE_SCAN_BATCH = 50;

const log = pino({
  name: "pr-state-scan",
  level: process.env.LOG_LEVEL ?? "info",
});

type QueryResult = { rows?: unknown[] };

type PrStateScanDb = {
  execute(query: SQL): Promise<QueryResult>;
  transaction<T>(transaction: (tx: PrStateScanDb) => Promise<T>): Promise<T>;
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
  cursor: string | null;
  reason?: string;
};

// ADR-139: the per-project PR-state poll. A pure provider-read + DB job — it
// NEVER spawns a session, mutates git, or writes `runs.merge_commit_sha` (that
// column stays owned by repo_delivery_scan). It stamps `pr_state_checked_at` on
// every attempt and applies three edge-guarded, exactly-once state transitions.
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

  for (const candidate of candidates) {
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
  }

  // Advance past the processed window when it was full; a short (tail) batch
  // resets the cursor so the next tick wraps to the head — every candidate is
  // visited within ceil(N / batch) ticks regardless of never-moving rows.
  const nextCursor =
    candidates.length === PR_STATE_SCAN_BATCH
      ? candidates[candidates.length - 1].id
      : null;

  await writeCursor(db, projectId, nextCursor);

  const summary: PrStateScanSummary = {
    scanned: candidates.length,
    updated,
    skipped,
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
    log.warn(
      {
        projectId,
        prNumber: candidate.pr_number,
        transient: result.transient,
        reason: result.reason,
      },
      "pr state candidate skipped",
    );

    if (result.transient) {
      // Retryable — stamp only, stays in the candidate set for the next tick.
      await stampChecked(db, candidate.id);
    } else {
      // Terminal (404/deleted/invalid): close so it leaves the candidate set
      // and is never retried forever. NOT a webhook edge — a deleted PR is not
      // a real "closed" transition.
      await closeTerminal(db, candidate.id);
    }

    return "skipped";
  }

  // Defensive — step 1 already returns early for a generic provider, so a live
  // `unsupported` should not reach here. Stamp and move on.
  if (result.kind === "unsupported") {
    await stampChecked(db, candidate.id);

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

  // Conflicts edge — independent of the state edge (a still-open PR can gain a
  // conflict). The guard is the PREVIOUS column value so a re-scan is
  // exactly-once.
  if (state.hasConflicts === true) {
    changed = await conflictsEdge({ db, projectId, candidate });
  } else if (state.hasConflicts === false) {
    // Silent clear — no webhook.
    await db.execute(sql`
      UPDATE workspaces
      SET pr_has_conflicts = false
      WHERE id = ${candidate.id}
    `);
  }
  // hasConflicts === null → leave as-is.

  // State edge — merged / closed / open, mutually exclusive.
  if (state.state === "merged") {
    changed =
      (await mergedEdge({ db, projectId, candidate, state })) || changed;
  } else if (state.state === "closed") {
    changed = (await closedEdge({ db, projectId, candidate })) || changed;
  } else {
    // open — stamp progress; the row stays in the candidate set.
    await stampChecked(db, candidate.id);
  }

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
          SET pr_has_conflicts = true, pr_state_checked_at = now()
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
            pr_merge_commit_sha = ${state.mergeCommitSha},
            pr_state_checked_at = now()
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
        await tx.execute(sql`
          INSERT INTO task_activity (
            id, task_id, project_id, actor_type, actor_id, event_kind, payload, created_at
          )
          VALUES (
            ${randomUUID()},
            ${candidate.task_id},
            ${projectId},
            'system',
            NULL,
            'run_pr_merged',
            ${JSON.stringify({ prNumber: candidate.pr_number })}::jsonb,
            now()
          )
        `);
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
          SET pr_state = 'closed', pr_state_checked_at = now()
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

async function stampChecked(
  db: PrStateScanDb,
  workspaceId: string,
): Promise<void> {
  await db.execute(sql`
    UPDATE workspaces
    SET pr_state_checked_at = now()
    WHERE id = ${workspaceId}
  `);
}

async function closeTerminal(
  db: PrStateScanDb,
  workspaceId: string,
): Promise<void> {
  await db.execute(sql`
    UPDATE workspaces
    SET pr_state = 'closed', pr_state_checked_at = now()
    WHERE id = ${workspaceId}
      AND (pr_state IS NULL OR pr_state = 'open')
  `);
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
