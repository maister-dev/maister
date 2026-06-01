import "server-only";

import type { PreserveResult, PreserveWorktreeArgs } from "@/lib/gc/preserve";
import type { RemoveOwnedWorktreeArgs } from "@/lib/worktree";

import { access } from "node:fs/promises";

import { and, eq, inArray, isNull, isNotNull, lte, or } from "drizzle-orm";
import pino from "pino";

import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { gcAgeDays, gcArchivePush, worktreesRoot } from "@/lib/instance-config";
import { preserveWorktree } from "@/lib/gc/preserve";
import { removeOwnedWorktree } from "@/lib/worktree";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { projects, runs, workspaces } = schemaModule as unknown as Record<
  string,
  any
>;

// FIXME(any): dual drizzle-orm peer-dep variants.
type Db = any;

const log = pino({
  name: "gc-workspace",
  level: process.env.LOG_LEVEL ?? "info",
});

const PER_TICK_LIMIT = 100;
const PER_PASS_CONCURRENCY = 4;

export interface WorkspaceGcSummary {
  scanned: number;
  preserved: number;
  pruned: number;
  skippedUnpreserved: number;
  failed: number;
}

export interface RunWorkspaceGcSweepOptions {
  db?: Db;
  now?: () => Date;
  // Injection points are typed structurally (not `typeof`) so a test/sweeper can
  // supply a narrower-arg / wider-return spy while the production defaults below
  // remain the strict implementations. The preserve return is `unknown` to admit
  // a loosely-typed spy; it is narrowed to PreserveResult at the call site.
  preserveWorktree?: (args: PreserveWorktreeArgs) => Promise<unknown>;
  removeOwnedWorktree?: (args: RemoveOwnedWorktreeArgs) => Promise<void>;
  resolveBaseRef?: (args: { projectId: string; db: Db }) => Promise<string>;
  // §3.3 recovery probe. Defaults to a real `access()` check; injectable so
  // tests using synthetic (non-on-disk) worktree paths can opt into the
  // present-worktree path without provisioning real directories.
  worktreeExists?: (worktreePath: string) => Promise<boolean>;
}

type CandidateRow = {
  workspaceId: string;
  worktreePath: string;
  parentRepoPath: string;
  branch: string;
  runId: string;
  projectId: string;
};

// Default §3.3 recovery probe: does the worktree path still exist on disk?
async function defaultWorktreeExists(worktreePath: string): Promise<boolean> {
  return access(worktreePath).then(
    () => true,
    () => false,
  );
}

// Default base-ref resolver: a project's configured default branch. The
// preserve step only diffs base..branch to decide whether to archive — the
// project main branch is the right divergence anchor.
async function defaultResolveBaseRef(args: {
  projectId: string;
  db: Db;
}): Promise<string> {
  const rows = await args.db
    .select({ mainBranch: projects.mainBranch })
    .from(projects)
    .where(eq(projects.id, args.projectId));

  return rows[0]?.mainBranch ?? "main";
}

async function runWithConcurrency<T>(
  items: ReadonlyArray<T>,
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const workers: Promise<void>[] = [];

  async function worker(): Promise<void> {
    while (true) {
      const idx = cursor++;

      if (idx >= items.length) return;
      await fn(items[idx]);
    }
  }

  for (let i = 0; i < Math.min(limit, items.length); i++) {
    workers.push(worker());
  }
  await Promise.all(workers);
}

// Effective deadline (Codex F3, backfill-free):
//   scheduled_removal_at ?? (ended_at + gcAgeDays). A row is collectable when
// either the scheduled deadline is set and past, OR (no schedule) ended_at is
// older than gcAgeDays. removed_at IS NULL gates the whole select (idempotent
// re-run). Only terminal Abandoned/Done runs are eligible.
async function loadCandidates(db: Db, now: Date): Promise<CandidateRow[]> {
  const endedCutoff = new Date(now.getTime() - gcAgeDays() * 86_400_000);

  const rows = await db
    .select({
      workspaceId: workspaces.id,
      worktreePath: workspaces.worktreePath,
      parentRepoPath: workspaces.parentRepoPath,
      branch: workspaces.branch,
      runId: workspaces.runId,
      projectId: workspaces.projectId,
    })
    .from(workspaces)
    .innerJoin(runs, eq(runs.id, workspaces.runId))
    .where(
      and(
        isNull(workspaces.removedAt),
        inArray(runs.status, ["Abandoned", "Done"]),
        or(
          and(
            isNotNull(workspaces.scheduledRemovalAt),
            lte(workspaces.scheduledRemovalAt, now),
          ),
          and(
            isNull(workspaces.scheduledRemovalAt),
            lte(runs.endedAt, endedCutoff),
          ),
        ),
      ),
    )
    .limit(PER_TICK_LIMIT);

  return rows;
}

// Graceful workspace GC (Codex F1: preserve-then-prune). For each past-deadline
// terminal workspace: preserve EVERYTHING, then prune ONLY if preserve
// succeeded. A preserve failure leaves removed_at null and is retried next
// sweep — the work is never force-removed unpreserved. removed_at IS NULL gates
// re-entry, so a partial crash converges on re-run.
export async function runWorkspaceGcSweep(
  opts: RunWorkspaceGcSweepOptions = {},
): Promise<WorkspaceGcSummary> {
  const db = opts.db ?? getDb();
  const now = opts.now ?? (() => new Date());
  const preserve = opts.preserveWorktree ?? preserveWorktree;
  const remove = opts.removeOwnedWorktree ?? removeOwnedWorktree;
  const resolveBaseRef = opts.resolveBaseRef ?? defaultResolveBaseRef;
  const worktreeExists = opts.worktreeExists ?? defaultWorktreeExists;

  const candidates = await loadCandidates(db, now());

  log.info({ scanned: candidates.length }, "workspace GC sweep start");

  let preserved = 0;
  let pruned = 0;
  let skippedUnpreserved = 0;
  let failed = 0;

  await runWithConcurrency(candidates, PER_PASS_CONCURRENCY, async (cand) => {
    try {
      // §3.3 pruned-not-marked recovery: a prior tick removed the worktree but
      // died before the DB write, so removed_at is still null. The work (if
      // any) was already archived in that tick's preserve. Re-running preserve
      // here would throw on the missing path → {ok:false} → the row would stick
      // as skippedUnpreserved forever. Detect the missing worktree and converge
      // the DB directly instead.
      const exists = await worktreeExists(cand.worktreePath);

      if (!exists) {
        await db
          .update(workspaces)
          .set({ removedAt: now() })
          .where(eq(workspaces.id, cand.workspaceId));

        pruned += 1;
        log.info(
          { workspaceId: cand.workspaceId, runId: cand.runId },
          "[gc] worktree already gone — marking removed_at (pruned-not-marked recovery)",
        );

        return;
      }

      const baseRef = await resolveBaseRef({ projectId: cand.projectId, db });
      const r = (await preserve({
        worktreePath: cand.worktreePath,
        parentRepoPath: cand.parentRepoPath,
        branch: cand.branch,
        baseRef,
        runId: cand.runId,
        archivePush: gcArchivePush(),
      })) as PreserveResult;

      if (!r.ok) {
        skippedUnpreserved += 1;
        log.warn(
          { workspaceId: cand.workspaceId, runId: cand.runId },
          "workspace GC: preserve failed — skipping removal (removed_at stays null)",
        );

        return;
      }

      await remove({
        worktreePath: cand.worktreePath,
        projectRepoPath: cand.parentRepoPath,
        force: true,
        allowedRoot: worktreesRoot(),
      });

      await db
        .update(workspaces)
        .set({
          removedAt: now(),
          archivedBranch: r.archivedBranch ?? null,
          archivedAt: r.archivedAt ?? null,
        })
        .where(eq(workspaces.id, cand.workspaceId));

      pruned += 1;
      if (r.archivedBranch) preserved += 1;
      log.info(
        {
          workspaceId: cand.workspaceId,
          runId: cand.runId,
          archivedBranch: r.archivedBranch ?? null,
        },
        "workspace GC: preserved then pruned",
      );
    } catch (err) {
      failed += 1;
      log.error(
        {
          workspaceId: cand.workspaceId,
          runId: cand.runId,
          err: err instanceof Error ? err.message : String(err),
        },
        "workspace GC: row failed — continuing",
      );
    }
  });

  const summary: WorkspaceGcSummary = {
    scanned: candidates.length,
    preserved,
    pruned,
    skippedUnpreserved,
    failed,
  };

  log.info(summary, "workspace GC sweep complete");

  return summary;
}
