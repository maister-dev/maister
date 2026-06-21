import "server-only";

import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { DiffPrepResult } from "@/lib/diff/prepare";
import type { Placement } from "@/lib/review-comments/anchor";
import type {
  ReviewComment,
  ReviewCommentThread,
} from "@/lib/review-comments/service";

import { and, eq } from "drizzle-orm";
import pino from "pino";

import { getDb } from "@/lib/db/client";
import { projects, runs, workspaces } from "@/lib/db/schema";
import { filterDiffByPath, prepareDiff } from "@/lib/diff/prepare";
import { MaisterError } from "@/lib/errors";
import { computePlacement } from "@/lib/review-comments/anchor";
import { listThreads } from "@/lib/review-comments/service";
import { isReviewableChangePath } from "@/lib/runs/reviewable-changes";
import {
  diffRunWorkspace,
  diffWorkingTree,
  resolveBaseRef,
} from "@/lib/worktree";

// ADR-072: the server-recomputed run diff + placement summary shared by the
// review-comment routes and the run-detail layout's gate panel (Task 13 —
// `computeRunDiff`/`placementOf` extracted from the collection route once the
// layout became the third consumer). Behavior-identical to the route-private
// originals; the route tests keep pinning them through GET/POST.

const log = pino({
  name: "review-comments-diff",
  level: process.env.LOG_LEVEL ?? "info",
});

// FIXME(any): getDb() returns a pg|sqlite drizzle union; narrow to pg.
function db(): NodePgDatabase {
  return getDb() as unknown as NodePgDatabase;
}

export interface RunDiffSourceRef {
  id: string;
  projectId: string;
}

type WorkspaceRow = typeof workspaces.$inferSelect;
type ProjectRow = typeof projects.$inferSelect;

interface ReviewDiffRows {
  workspace: WorkspaceRow;
  project: ProjectRow;
}

export const REVIEW_COMMENT_SCOPES = ["run", "uncommitted"] as const;

export type ReviewCommentScope = (typeof REVIEW_COMMENT_SCOPES)[number];

export function reviewCommentScopeOrDefault(
  raw: string | null,
): ReviewCommentScope {
  if (raw === null || raw === "run") return "run";
  if (raw === "uncommitted") return "uncommitted";

  throw new MaisterError("CONFIG", `unsupported review-comment scope: ${raw}`);
}

// M37 (ADR-101): resolve the shared TREE workspace for a writable shared child
// (READ path). A shared writable tree is ONE git worktree owned by the ALLOCATOR
// child's `workspaces` row; a REUSER child of the same tree (`root_run_id`)
// carries NO row of its own. Find the allocator's row by joining `runs` on
// `(root_run_id, workspace_mode='shared', agent_workspace='worktree')` so the
// gate-diff renders the one shared diff. No FOR UPDATE — read-only.
async function resolveSharedTreeWorkspaceForRead(
  dbh: NodePgDatabase,
  rootRunId: string,
): Promise<WorkspaceRow | undefined> {
  const rows = await dbh
    .select()
    .from(workspaces)
    .innerJoin(runs, eq(runs.id, workspaces.runId))
    .where(
      and(
        eq(runs.rootRunId, rootRunId),
        eq(runs.workspaceMode, "shared"),
        eq(runs.agentWorkspace, "worktree"),
      ),
    );

  return rows[0]?.workspaces;
}

async function loadReviewDiffRows(
  dbh: NodePgDatabase,
  run: RunDiffSourceRef,
): Promise<ReviewDiffRows> {
  // RunDiffSourceRef carries only id+projectId — load the run row to learn
  // whether it is a shared writable agent child (a reuser owns no workspaces
  // row of its own → tree-resolve), vs an own/scratch/flow run (run-id lookup).
  const runRows = await dbh
    .select({
      runKind: runs.runKind,
      workspaceMode: runs.workspaceMode,
      agentWorkspace: runs.agentWorkspace,
      rootRunId: runs.rootRunId,
    })
    .from(runs)
    .where(eq(runs.id, run.id));
  const runRow = runRows[0];
  const isSharedTreeChild =
    runRow?.runKind === "agent" &&
    runRow.workspaceMode === "shared" &&
    runRow.agentWorkspace === "worktree" &&
    runRow.rootRunId !== null;

  const [workspace, projectRows] = await Promise.all([
    isSharedTreeChild
      ? resolveSharedTreeWorkspaceForRead(dbh, runRow.rootRunId as string)
      : dbh
          .select()
          .from(workspaces)
          .where(eq(workspaces.runId, run.id))
          .then((rows) => rows[0]),
    dbh.select().from(projects).where(eq(projects.id, run.projectId)),
  ]);
  const project = projectRows[0];

  if (!workspace) {
    throw new MaisterError("PRECONDITION", `workspace not found: ${run.id}`);
  }
  if (isSharedTreeChild) {
    log.debug(
      {
        runId: run.id,
        rootRunId: runRow.rootRunId,
        workspaceId: workspace.id,
        worktreePath: workspace.worktreePath,
      },
      "[review-diff] resolved shared tree workspace for reuser child",
    );
  }
  if (workspace.removedAt) {
    throw new MaisterError(
      "PRECONDITION",
      `workspace already removed for run: ${run.id}`,
    );
  }
  if (!project) {
    throw new MaisterError("PRECONDITION", `project not found: ${run.id}`);
  }

  return { workspace, project };
}

// The same diff source the review view renders (diffRunWorkspace +
// prepareDiff over the committed base..branch range) — computed at most ONCE
// per request.
export async function computeRunDiff(
  dbh: NodePgDatabase,
  run: RunDiffSourceRef,
): Promise<DiffPrepResult> {
  const { workspace, project } = await loadReviewDiffRows(dbh, run);

  const base =
    workspace.baseCommit ??
    (await resolveBaseRef({
      worktreePath: workspace.worktreePath,
      branch: workspace.branch,
      mainBranch: project.mainBranch,
    }));
  const { text, truncated } = await diffRunWorkspace({
    projectRepoPath: workspace.worktreePath,
    baseCommit: base,
    branch: workspace.branch,
  });

  return prepareDiff(text, truncated);
}

async function computeUncommittedReviewDiff(
  dbh: NodePgDatabase,
  run: RunDiffSourceRef,
): Promise<DiffPrepResult> {
  const { workspace } = await loadReviewDiffRows(dbh, run);
  const { text, truncated } = await diffWorkingTree(workspace.worktreePath);
  const reviewableDiff = filterDiffByPath(text, isReviewableChangePath);

  return prepareDiff(reviewableDiff, truncated);
}

export function computeReviewDiff(
  dbh: NodePgDatabase,
  run: RunDiffSourceRef,
  scope: ReviewCommentScope,
): Promise<DiffPrepResult> {
  if (scope === "run") return computeRunDiff(dbh, run);

  return computeUncommittedReviewDiff(dbh, run);
}

// Roots carry all anchor fields (DB CHECK); the null guard only keeps the
// mapping total — a defective row degrades to "outdated", never a crash.
export function placementOf(
  prepared: DiffPrepResult | null,
  root: ReviewComment,
): Placement {
  if (!prepared) return "outdated";

  const { filePath, side, line, lineContent } = root;

  if (
    filePath === null ||
    side === null ||
    line === null ||
    lineContent === null
  ) {
    return "outdated";
  }

  return computePlacement(prepared, { filePath, side, line, lineContent });
}

export interface ReviewThreadCounts {
  openCount: number;
  outdatedCount: number;
}

// Gate-panel counts (ADR-072 D5): open root threads, and the open subset whose
// placement against the CURRENT diff is "outdated". Resolved threads and
// replies never count. A missing diff degrades every open root to outdated —
// matching the GET route's read behavior.
export function summarizeReviewThreads(
  threads: ReviewCommentThread[],
  prepared: DiffPrepResult | null,
): ReviewThreadCounts {
  const openRoots = threads.filter((t) => t.root.status === "open");
  const outdatedCount = openRoots.filter(
    (t) => placementOf(prepared, t.root) === "outdated",
  ).length;

  return { openCount: openRoots.length, outdatedCount };
}

// Layout glue for the open-review-gate panel: exactly ONE threads query plus
// AT MOST one diff computation — skipped entirely when no root is open
// (outdatedCount only covers OPEN roots, so the diff buys nothing there).
export async function getReviewGateThreadCounts(
  runId: string,
  projectId: string,
): Promise<ReviewThreadCounts> {
  const dbh = db();
  const threads = await listThreads(dbh, runId);

  if (!threads.some((t) => t.root.status === "open")) {
    return { openCount: 0, outdatedCount: 0 };
  }

  let prepared: DiffPrepResult | null = null;

  try {
    prepared = await computeRunDiff(dbh, { id: runId, projectId });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    log.warn(
      { runId, err: message },
      "diff unavailable — gate-panel placements degrade to outdated",
    );
  }

  return summarizeReviewThreads(threads, prepared);
}
