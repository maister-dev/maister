import "server-only";

import { and, count, eq, inArray, notInArray } from "drizzle-orm";
import pino from "pino";

import * as schemaModule from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import {
  FAILURE_TERMINAL_RUN_STATUSES,
  SETTLED_RUN_STATUSES,
} from "@/lib/runs/run-status-sets";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { runs, workspaces } = schemaModule as unknown as Record<string, any>;

// FIXME(any): route + tests pass a minimal drizzle-like fake / a Testcontainers
// pg client; both expose select/update/transaction.
type Db = any;

const log = pino({
  name: "shared-tree",
  level: process.env.LOG_LEVEL ?? "info",
});

// M37 (ADR-102): resolve + lock the shared TREE workspace for a writable shared
// child. Only the allocator owns a `workspaces` row (`worktree_path` is UNIQUE,
// keyed by the tree root); a reuser child has none. Find the allocator's row by
// joining `runs` on `(root_run_id, workspace_mode='shared', agent_workspace=
// 'worktree')`, then lock THAT row FOR UPDATE — so every shared child (allocator
// OR reuser) promotes the one tree workspace and concurrent tree-promotes
// serialize on the same row (the exactly-once handle).
export async function resolveSharedTreeWorkspaceForUpdate(
  db: Db,
  run: { rootRunId?: string | null },
): Promise<any> {
  if (!run.rootRunId) {
    throw new MaisterError(
      "PRECONDITION",
      "shared-tree promote: run has no root_run_id",
    );
  }

  const found = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .innerJoin(runs, eq(runs.id, workspaces.runId))
    .where(
      and(
        eq(runs.rootRunId, run.rootRunId),
        eq(runs.workspaceMode, "shared"),
        eq(runs.agentWorkspace, "worktree"),
      ),
    );
  const allocatorWorkspaceId = found[0]?.id;

  if (!allocatorWorkspaceId) {
    throw new MaisterError(
      "PRECONDITION",
      `shared-tree workspace not found for root ${run.rootRunId}`,
    );
  }

  const rows = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, allocatorWorkspaceId))
    .for("update");
  const workspace = rows[0];

  if (!workspace) {
    throw new MaisterError(
      "PRECONDITION",
      `shared-tree workspace not found for root ${run.rootRunId}`,
    );
  }
  if (workspace.removedAt) {
    throw new MaisterError(
      "PRECONDITION",
      `shared-tree workspace already removed for root ${run.rootRunId}`,
    );
  }

  log.debug(
    {
      rootRunId: run.rootRunId,
      workspaceId: workspace.id,
      worktreePath: workspace.worktreePath,
    },
    "resolved shared tree workspace for promote",
  );

  return workspace;
}

// M37 (ADR-102): a READ-only lookup of the shared tree's allocator `workspaces`
// row (NO FOR UPDATE). Used by the launch allocator decision (F3): a row means
// the tree already exists in the DB (genuine reuser), absence means THIS child
// owns the row (allocator or orphan-claim). Returns null when no row exists.
export async function findSharedTreeWorkspace(
  db: Db,
  rootRunId: string,
): Promise<{ id: string; worktreePath: string } | null> {
  const rows = await db
    .select({ id: workspaces.id, worktreePath: workspaces.worktreePath })
    .from(workspaces)
    .innerJoin(runs, eq(runs.id, workspaces.runId))
    .where(
      and(
        eq(runs.rootRunId, rootRunId),
        eq(runs.workspaceMode, "shared"),
        eq(runs.agentWorkspace, "worktree"),
      ),
    )
    .limit(1);

  return rows[0] ?? null;
}

// M37 (ADR-102): the settled-gate predicate — count shared siblings of a tree NOT
// in SETTLED_RUN_STATUSES (terminal + Review), i.e. still in a writable status.
// Used at BOTH promote-time guards (the claim-tx gate AND the finalize-tx re-check)
// so the two can never drift.
export async function countUnsettledSharedSiblings(
  db: Db,
  rootRunId: string,
): Promise<number> {
  const rows = await db
    .select({ c: count() })
    .from(runs)
    .where(
      and(
        eq(runs.rootRunId, rootRunId),
        eq(runs.workspaceMode, "shared"),
        eq(runs.agentWorkspace, "worktree"),
        notInArray(runs.status, [...SETTLED_RUN_STATUSES]),
      ),
    );

  return Number(rows[0]?.c ?? 0);
}

// M37 (ADR-102) F2: count shared siblings of a tree in a FAILURE-terminal status
// (Failed | Crashed | Abandoned). The auto-promoter uses this to SKIP an
// unattended tree-merge that would absorb a failed sibling's partial, unreviewed
// commits — leaving the tree for a human (manual promote stays allowed; a human
// reviews the whole tree-diff). The settled-gate (countUnsettledSharedSiblings)
// is unchanged: a failure-terminal sibling IS settled for the WRITER-safety gate.
export async function countFailureTerminalSharedSiblings(
  db: Db,
  rootRunId: string,
): Promise<number> {
  const rows = await db
    .select({ c: count() })
    .from(runs)
    .where(
      and(
        eq(runs.rootRunId, rootRunId),
        eq(runs.workspaceMode, "shared"),
        eq(runs.agentWorkspace, "worktree"),
        inArray(runs.status, [...FAILURE_TERMINAL_RUN_STATUSES]),
      ),
    );

  return Number(rows[0]?.c ?? 0);
}
