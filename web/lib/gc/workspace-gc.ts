import "server-only";

import type { PreserveResult, PreserveWorktreeArgs } from "@/lib/gc/preserve";
import type { RemoveOwnedWorktreeArgs } from "@/lib/worktree";

import { access } from "node:fs/promises";

import {
  and,
  asc,
  eq,
  exists,
  inArray,
  isNull,
  isNotNull,
  lte,
  notExists,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import pino from "pino";

import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { gcAgeDays, gcArchivePush, worktreesRoot } from "@/lib/instance-config";
import { deleteRunCheckpointRefs } from "@/lib/flows/graph/workspace-checkpoint";
import { preserveWorktree } from "@/lib/gc/preserve";
import { MaisterError } from "@/lib/errors";
import { removeOwnedWorktree } from "@/lib/worktree";
import { DISPOSABLE_WORKSPACE_RUN_STATUSES } from "@/lib/runs/run-status-sets";
import {
  claimLifecycleOperation,
  finalizeLifecycleOperation,
  recordArchive,
  recordDrop,
  renewLifecycleOperationLease,
} from "@/lib/workbench-lifecycle/service";

// FIXME(any): dual drizzle-orm peer-dep variants.
const {
  evaluationParticipants,
  evaluationStudies,
  experimentRuns,
  experiments,
  projects,
  runs,
  workspaces,
} = schemaModule as unknown as Record<string, any>;

// FIXME(any): dual drizzle-orm peer-dep variants.
type Db = any;

const log = pino({
  name: "gc-workspace",
  level: process.env.LOG_LEVEL ?? "info",
});

const PER_TICK_LIMIT = 100;
const PER_PASS_CONCURRENCY = 4;
const RETRY_DELAY_MS = 15 * 60_000;

type DisposableWorkspaceRunStatus =
  (typeof DISPOSABLE_WORKSPACE_RUN_STATUSES)[number];
type PreservationOutcome = "not_needed" | "ref_created" | "snapshot_created";

export interface WorkspaceGcSummary {
  scanned: number;
  preserved: number;
  pruned: number;
  skippedUnpreserved: number;
  skippedClaimed: number;
  retryableFailed: number;
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
  // M30 (ADR-079): checkpoint refs are repo-global — worktree removal never
  // cleans them, so the sweep deletes refs/maister/{checkpoints,
  // chat-checkpoints}/<runId>/* from the PARENT repo. Best-effort.
  deleteRunCheckpointRefs?: (
    repoPath: string,
    runId: string,
  ) => Promise<number>;
}

type CandidateRow = {
  workspaceId: string;
  worktreePath: string;
  parentRepoPath: string;
  branch: string;
  runId: string;
  projectId: string;
  rootRunId: string | null;
  runKind: "flow" | "scratch" | "agent";
  runStatus: DisposableWorkspaceRunStatus;
  archivedBranch: string | null;
  archivedAt: Date | null;
  archivedCommit: string | null;
  preservationOutcome: PreservationOutcome | "legacy_unknown" | null;
};

function preservationOutcome(result: PreserveResult): PreservationOutcome {
  if (result.preservationOutcome === "ref_created") {
    return "ref_created";
  }

  if (result.preservationOutcome === "snapshot_created" || result.snapshotted) {
    return "snapshot_created";
  }

  return "not_needed";
}

function persistedPreservationOutcome(
  candidate: CandidateRow,
): PreservationOutcome {
  if (candidate.preservationOutcome === "ref_created") {
    return "ref_created";
  }

  if (candidate.preservationOutcome === "snapshot_created") {
    return "snapshot_created";
  }

  return "not_needed";
}

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

  // T16 (ADR-102): a shared writable tree is ONE worktree owned by the
  // ALLOCATOR child's `workspaces` row; N reuser siblings of the same
  // orchestrator tree (root_run_id) write into it but own no row. The owning
  // run terminating does NOT make the worktree collectable while a sibling is
  // still writing — collecting it would pull the directory out from under a
  // live agent. So a shared-writable allocator is EXCLUDED while any shared
  // sibling of its tree is still non-terminal; once every shared sibling is
  // terminal the workspace becomes a candidate. Non-shared workspaces are
  // unaffected (the OR short-circuits on the first leg).
  const sibling = alias(runs, "shared_sibling");
  const treeNotBlocked = or(
    notInArray(runs.workspaceMode, ["shared"]),
    isNull(runs.workspaceMode),
    isNull(runs.rootRunId),
    notInArray(runs.agentWorkspace, ["worktree"]),
    notExists(
      db
        .select({ one: sibling.id })
        .from(sibling)
        .where(
          and(
            eq(sibling.rootRunId, runs.rootRunId),
            eq(sibling.workspaceMode, "shared"),
            eq(sibling.agentWorkspace, "worktree"),
            notInArray(sibling.status, [...DISPOSABLE_WORKSPACE_RUN_STATUSES]),
          ),
        ),
    ),
  );
  const experimentNotBlocked = notExists(
    db
      .select({ one: experimentRuns.id })
      .from(experimentRuns)
      .innerJoin(experiments, eq(experiments.id, experimentRuns.experimentId))
      .where(
        and(
          eq(experimentRuns.runId, runs.id),
          notInArray(experiments.status, ["concluded", "abandoned"]),
        ),
      ),
  );
  // Evaluation-lab evidence hold (ADR-146 D15, mirroring the experiment join):
  // a launched participant's worktree is study evidence — later executions
  // (judge captures, verdicts) read it, so it must survive until the study
  // reaches a terminal status. `draft`/`open` are the live set; only
  // `decided`/`archived` release the hold (schema.ts evaluation_studies status
  // check). Deliberately NOT filtered on removed_at: a tombstoned launched
  // participant still holds its run (membership immutability).
  const evaluationNotBlocked = notExists(
    db
      .select({ one: evaluationParticipants.id })
      .from(evaluationParticipants)
      .innerJoin(
        evaluationStudies,
        eq(evaluationStudies.id, evaluationParticipants.studyId),
      )
      .where(
        and(
          eq(evaluationParticipants.runId, runs.id),
          eq(evaluationParticipants.sourceType, "launched"),
          notInArray(evaluationStudies.status, ["decided", "archived"]),
        ),
      ),
  );

  const rows = await db
    .select({
      workspaceId: workspaces.id,
      worktreePath: workspaces.worktreePath,
      parentRepoPath: workspaces.parentRepoPath,
      branch: workspaces.branch,
      runId: workspaces.runId,
      projectId: workspaces.projectId,
      rootRunId: runs.rootRunId,
      runKind: runs.runKind,
      runStatus: runs.status,
      archivedBranch: workspaces.archivedBranch,
      archivedAt: workspaces.archivedAt,
      archivedCommit: workspaces.archivedCommit,
      preservationOutcome: workspaces.preservationOutcome,
    })
    .from(workspaces)
    .innerJoin(runs, eq(runs.id, workspaces.runId))
    .where(
      and(
        isNull(workspaces.removedAt),
        inArray(runs.status, [...DISPOSABLE_WORKSPACE_RUN_STATUSES]),
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
        treeNotBlocked,
        experimentNotBlocked,
        evaluationNotBlocked,
      ),
    )
    .orderBy(
      asc(workspaces.scheduledRemovalAt),
      asc(runs.endedAt),
      asc(workspaces.id),
    )
    .limit(PER_TICK_LIMIT);

  return rows as CandidateRow[];
}

// T16 observability: emit one debug line per workspace that WOULD be due but is
// held back solely by the shared-tree guard (its owning shared-writable
// allocator is terminal/past-deadline while ≥1 shared sibling of the same tree
// is still non-terminal). Reports the live-sibling count. Best-effort — never
// blocks the sweep.
async function logTreeBlockedSkips(db: Db, now: Date): Promise<void> {
  const endedCutoff = new Date(now.getTime() - gcAgeDays() * 86_400_000);
  const sibling = alias(runs, "blocking_sibling");

  // Live-sibling predicate, reused as both the COUNT column (scalar subquery)
  // and the EXISTS row-gate. Hand-built `db.select().from(sibling)` subqueries
  // each emit their own `from "runs" "blocking_sibling"` in their own scope, so
  // the shared alias name is safe (unlike `$count`, which mis-nests the alias).
  const liveSiblingWhere = and(
    eq(sibling.rootRunId, runs.rootRunId),
    eq(sibling.workspaceMode, "shared"),
    eq(sibling.agentWorkspace, "worktree"),
    notInArray(sibling.status, [...DISPOSABLE_WORKSPACE_RUN_STATUSES]),
  );
  const countSubquery = db
    .select({ c: sql<number>`count(*)::int` })
    .from(sibling)
    .where(liveSiblingWhere);
  const presenceSubquery = db
    .select({ one: sql`1` })
    .from(sibling)
    .where(liveSiblingWhere);

  const blocked = await db
    .select({
      workspaceId: workspaces.id,
      rootRunId: runs.rootRunId,
      blockingSiblingCount: sql<number>`(${countSubquery})`,
    })
    .from(workspaces)
    .innerJoin(runs, eq(runs.id, workspaces.runId))
    .where(
      and(
        isNull(workspaces.removedAt),
        inArray(runs.status, [...DISPOSABLE_WORKSPACE_RUN_STATUSES]),
        eq(runs.workspaceMode, "shared"),
        eq(runs.agentWorkspace, "worktree"),
        isNotNull(runs.rootRunId),
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
        exists(presenceSubquery),
      ),
    )
    .limit(PER_TICK_LIMIT);

  for (const row of blocked as Array<{
    workspaceId: string;
    rootRunId: string | null;
    blockingSiblingCount: number;
  }>) {
    log.debug(
      {
        workspaceId: row.workspaceId,
        rootRunId: row.rootRunId,
        blockingSiblingCount: Number(row.blockingSiblingCount),
      },
      "[gc] shared-tree workspace held back — non-terminal sibling(s) still writing",
    );
  }
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
  const deleteCheckpointRefs =
    opts.deleteRunCheckpointRefs ?? deleteRunCheckpointRefs;

  // Best-effort: a ref-deletion failure must never block the prune — orphaned
  // refs are harmless (dangling commits) and retried by later manual cleanup.
  const gcCheckpointRefs = async (cand: CandidateRow): Promise<void> => {
    try {
      await deleteCheckpointRefs(cand.parentRepoPath, cand.runId);
    } catch (err) {
      log.warn(
        {
          runId: cand.runId,
          errorType: err instanceof Error ? err.name : "unknown",
        },
        "[checkpoint] ref GC failed — refs remain orphaned (harmless)",
      );
    }
  };

  const scheduleRetry = async (cand: CandidateRow): Promise<void> => {
    const retryAt = new Date(now().getTime() + RETRY_DELAY_MS);

    await db
      .update(workspaces)
      .set({ scheduledRemovalAt: retryAt })
      .where(
        and(eq(workspaces.id, cand.workspaceId), isNull(workspaces.removedAt)),
      );

    log.warn(
      {
        workspaceId: cand.workspaceId,
        runId: cand.runId,
        retryAt,
      },
      "workspace GC retry scheduled",
    );
  };

  const candidates = await loadCandidates(db, now());

  // Best-effort observability: report shared-tree workspaces held back by a
  // still-writing sibling. A failure here must never block the sweep.
  try {
    await logTreeBlockedSkips(db, now());
  } catch (err) {
    log.warn(
      { errorType: err instanceof Error ? err.name : "unknown" },
      "[gc] shared-tree skip diagnostics failed (non-fatal)",
    );
  }

  log.info({ scanned: candidates.length }, "workspace GC sweep start");

  let preserved = 0;
  let pruned = 0;
  let skippedUnpreserved = 0;
  let skippedClaimed = 0;
  let retryableFailed = 0;
  let failed = 0;

  await runWithConcurrency(candidates, PER_PASS_CONCURRENCY, async (cand) => {
    let attemptId: string | null = null;

    try {
      const claim = await claimLifecycleOperation({
        database: db,
        runId: cand.runId,
        workspaceId: cand.workspaceId,
        operation: "retention_gc",
        expectedRunStatus: cand.runStatus,
      });

      attemptId = claim.attemptId;

      // §3.3 pruned-not-marked recovery: a prior tick removed the worktree but
      // died before the DB write, so removed_at is still null. The work (if
      // any) was already archived in that tick's preserve. Re-running preserve
      // here would throw on the missing path → {ok:false} → the row would stick
      // as skippedUnpreserved forever. Detect the missing worktree and converge
      // the DB directly instead.
      const exists = await worktreeExists(cand.worktreePath);

      if (!exists) {
        await recordDrop({
          database: db,
          runId: cand.runId,
          runKind: cand.runKind,
          workspaceId: cand.workspaceId,
          removedAt: now(),
          expectedRunStatus: cand.runStatus,
          nextRunStatus: null,
          archivedBranch: cand.archivedBranch,
          archivedAt: cand.archivedAt,
          archivedCommit: cand.archivedCommit,
          preservationOutcome: persistedPreservationOutcome(cand),
          removalKind: "retention_gc",
          attemptId,
        });

        // The worktree is gone but its checkpoint refs persist in the shared
        // parent repo — clean them here too.
        await gcCheckpointRefs(cand);

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
        retryableFailed += 1;
        await finalizeLifecycleOperation({
          database: db,
          workspaceId: cand.workspaceId,
          attemptId,
          state: "failed",
        });
        await scheduleRetry(cand);
        log.warn(
          { workspaceId: cand.workspaceId, runId: cand.runId },
          "workspace GC preserve failed; removal deferred",
        );

        return;
      }

      const outcome = preservationOutcome(r);
      const archivedAt = r.archivedAt ?? now();

      await recordArchive({
        database: db,
        workspaceId: cand.workspaceId,
        attemptId,
        archivedBranch: r.archivedBranch ?? null,
        archivedAt,
        archivedCommit: r.archivedCommit ?? null,
        preservationOutcome: outcome,
      });

      await renewLifecycleOperationLease({
        database: db,
        workspaceId: cand.workspaceId,
        attemptId,
      });

      await remove({
        worktreePath: cand.worktreePath,
        projectRepoPath: cand.parentRepoPath,
        force: true,
        allowedRoot: worktreesRoot(),
      });

      await recordDrop({
        database: db,
        runId: cand.runId,
        runKind: cand.runKind,
        workspaceId: cand.workspaceId,
        removedAt: now(),
        expectedRunStatus: cand.runStatus,
        nextRunStatus: null,
        archivedBranch: r.archivedBranch ?? null,
        archivedAt,
        archivedCommit: r.archivedCommit ?? null,
        preservationOutcome: outcome,
        removalKind: "retention_gc",
        attemptId,
      });

      await gcCheckpointRefs(cand);

      pruned += 1;
      if (outcome !== "not_needed") preserved += 1;
      log.info(
        {
          workspaceId: cand.workspaceId,
          runId: cand.runId,
          preservationOutcome: outcome,
        },
        "workspace GC preserved then pruned",
      );
    } catch (err) {
      if (err instanceof MaisterError && err.code === "CONFLICT") {
        skippedClaimed += 1;
        log.warn(
          {
            workspaceId: cand.workspaceId,
            runId: cand.runId,
            errorCode: err.code,
          },
          "workspace GC lifecycle claim unavailable",
        );

        return;
      }

      failed += 1;
      retryableFailed += 1;

      if (attemptId !== null) {
        try {
          await finalizeLifecycleOperation({
            database: db,
            workspaceId: cand.workspaceId,
            attemptId,
            state: "failed",
          });
          await scheduleRetry(cand);
        } catch (finalizeError) {
          log.error(
            {
              workspaceId: cand.workspaceId,
              runId: cand.runId,
              errorType:
                finalizeError instanceof Error ? finalizeError.name : "unknown",
            },
            "workspace GC failed to persist retry state",
          );
        }
      }

      log.error(
        {
          workspaceId: cand.workspaceId,
          runId: cand.runId,
          errorType: err instanceof Error ? err.name : "unknown",
        },
        "workspace GC row failed",
      );
    }
  });

  const summary: WorkspaceGcSummary = {
    scanned: candidates.length,
    preserved,
    pruned,
    skippedUnpreserved,
    skippedClaimed,
    retryableFailed,
    failed,
  };

  log.info(summary, "workspace GC sweep complete");

  return summary;
}
