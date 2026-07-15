import "server-only";

import { eq } from "drizzle-orm";
import pino from "pino";

import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { markReopenFromDone } from "@/lib/runs/state-transitions";
import { emitWebhookEvent } from "@/lib/webhooks/outbox";
import {
  addWorktreeForBranch,
  createLocalBranchAt,
  fetchRemote,
  localBranchHead,
  remoteTrackingBranchHead,
} from "@/lib/worktree";

// FIXME(any): dual drizzle-orm peer-dep variants — mirror sync-target.ts.
const { runs, workspaces, tasks } = schemaModule as unknown as Record<
  string,
  any
>;

type Db = any;

const log = pino({
  name: "run-reopen",
  level: process.env.LOG_LEVEL ?? "info",
});

const ORIGIN = "origin";

export type ReopenEligibilityRun = {
  status: string;
  runKind: string;
  parentRunId: string | null;
  workspaceMode: string | null;
};

export type ReopenEligibilityWorkspace = {
  prState: string | null;
  prHasConflicts: boolean | null;
};

export type ReopenActor = {
  type: "user" | "agent" | "system";
  id: string | null;
};

// Pure eligibility gate (ADR-138 decision 14): a top-level (`parent_run_id IS
// NULL`) `flow|agent` run in `Done` on an own (non-shared) tree whose workspace
// has an OPEN or CONFLICTED PR. Throws `PRECONDITION` naming the blocker.
export function assertReopenEligible(
  run: ReopenEligibilityRun,
  workspace: ReopenEligibilityWorkspace,
): void {
  if (run.status !== "Done") {
    throw new MaisterError(
      "PRECONDITION",
      `run is not Done (status=${run.status}); only a Done run can be reopened`,
    );
  }
  if (run.runKind !== "flow" && run.runKind !== "agent") {
    throw new MaisterError(
      "PRECONDITION",
      `run_kind=${run.runKind} cannot be reopened (flow|agent only)`,
    );
  }
  if (run.parentRunId !== null) {
    throw new MaisterError(
      "PRECONDITION",
      "an orchestrator child run cannot be reopened",
    );
  }
  if (run.workspaceMode === "shared") {
    throw new MaisterError(
      "PRECONDITION",
      "a shared-tree run cannot be reopened",
    );
  }

  const prOpen = workspace.prState === "open";
  const prConflicted = workspace.prHasConflicts === true;

  if (!prOpen && !prConflicted) {
    throw new MaisterError(
      "PRECONDITION",
      "reopen requires an open or conflicted PR on the workspace",
    );
  }
}

// Flip a top-level Done run back to Review so its stale/conflicted PR can be
// re-synced and re-promoted (ADR-138). One transaction: `Done->Review` CAS +
// `promotion_state='reopened'` + clear removal + stamp `review_entered_at` +
// `run.review` webhook + task `Done->InFlight` (re-gates released relations).
// A GC'd worktree is revived from the existing branch BEFORE the state flip.
export async function reopenRun(args: {
  runId: string;
  actor: ReopenActor;
  db?: Db;
}): Promise<{ status: "Review"; worktreeRevived: boolean }> {
  const db = (args.db ?? getDb()) as Db;
  const { runId } = args;

  const [run] = await db
    .select({
      status: runs.status,
      runKind: runs.runKind,
      parentRunId: runs.parentRunId,
      workspaceMode: runs.workspaceMode,
      projectId: runs.projectId,
      taskId: runs.taskId,
    })
    .from(runs)
    .where(eq(runs.id, runId));

  if (!run) {
    throw new MaisterError("PRECONDITION", `run not found: ${runId}`);
  }

  const [ws] = await db
    .select({
      id: workspaces.id,
      prState: workspaces.prState,
      prHasConflicts: workspaces.prHasConflicts,
      removedAt: workspaces.removedAt,
      worktreePath: workspaces.worktreePath,
      parentRepoPath: workspaces.parentRepoPath,
      branch: workspaces.branch,
    })
    .from(workspaces)
    .where(eq(workspaces.runId, runId));

  if (!ws) {
    throw new MaisterError("PRECONDITION", `run has no workspace: ${runId}`);
  }

  assertReopenEligible(run, ws);

  // GC'd-worktree revival (git side effect) runs BEFORE the DB state flip so a
  // git failure leaves the run untouched at Done.
  let worktreeRevived = false;

  if (ws.removedAt) {
    const localHead = await localBranchHead({
      projectRepoPath: ws.parentRepoPath,
      branch: ws.branch,
    });

    if (!localHead) {
      await fetchRemote({
        projectRepoPath: ws.parentRepoPath,
        name: ORIGIN,
      }).catch(() => undefined);
      const remoteHead = await remoteTrackingBranchHead({
        projectRepoPath: ws.parentRepoPath,
        branch: ws.branch,
        remote: ORIGIN,
      });

      if (!remoteHead) {
        throw new MaisterError(
          "PRECONDITION",
          `run branch is gone from both local and remote: ${ws.branch}`,
        );
      }
      await createLocalBranchAt(ws.parentRepoPath, ws.branch, remoteHead);
    }

    await addWorktreeForBranch(ws.parentRepoPath, ws.worktreePath, ws.branch);
    worktreeRevived = true;
  }

  await db.transaction(async (tx: Db) => {
    const cas = await markReopenFromDone(runId, { db: tx });

    if (!cas.ok) {
      throw new MaisterError(
        "CONFLICT",
        `run is no longer Done (concurrent transition): ${runId}`,
      );
    }

    await tx
      .update(runs)
      .set({ reviewEnteredAt: new Date() })
      .where(eq(runs.id, runId));

    await tx
      .update(workspaces)
      .set({
        promotionState: "reopened",
        scheduledRemovalAt: null,
        removedAt: null,
        archivedAt: null,
        archivedBranch: null,
      })
      .where(eq(workspaces.id, ws.id));

    if (run.taskId) {
      await tx
        .update(tasks)
        .set({ status: "InFlight" })
        .where(eq(tasks.id, run.taskId));
    }

    await emitWebhookEvent({
      db: tx,
      type: "run.review",
      projectId: run.projectId,
      runId,
      data: { source: "workbench" },
    });
  });

  log.info(
    { runId, worktreeRevived, actor: args.actor.type },
    "run reopened Done -> Review",
  );

  return { status: "Review", worktreeRevived };
}
