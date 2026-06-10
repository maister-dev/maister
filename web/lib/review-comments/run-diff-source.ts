import "server-only";

import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { DiffPrepResult } from "@/lib/diff/prepare";
import type { Placement } from "@/lib/review-comments/anchor";
import type {
  ReviewComment,
  ReviewCommentThread,
} from "@/lib/review-comments/service";

import { eq } from "drizzle-orm";
import pino from "pino";

import { getDb } from "@/lib/db/client";
import { projects, workspaces } from "@/lib/db/schema";
import { prepareDiff } from "@/lib/diff/prepare";
import { MaisterError } from "@/lib/errors";
import { computePlacement } from "@/lib/review-comments/anchor";
import { listThreads } from "@/lib/review-comments/service";
import { diffRunWorkspace, resolveBaseRef } from "@/lib/worktree";

// ADR-071: the server-recomputed run diff + placement summary shared by the
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

// The same diff source the review view renders (diffRunWorkspace +
// prepareDiff over the committed base..branch range) — computed at most ONCE
// per request.
export async function computeRunDiff(
  dbh: NodePgDatabase,
  run: RunDiffSourceRef,
): Promise<DiffPrepResult> {
  const [workspaceRows, projectRows] = await Promise.all([
    dbh.select().from(workspaces).where(eq(workspaces.runId, run.id)),
    dbh.select().from(projects).where(eq(projects.id, run.projectId)),
  ]);
  const workspace = workspaceRows[0];
  const project = projectRows[0];

  if (!workspace) {
    throw new MaisterError("PRECONDITION", `workspace not found: ${run.id}`);
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

// Gate-panel counts (ADR-071 D5): open root threads, and the open subset whose
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
