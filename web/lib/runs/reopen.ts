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
  removeWorktree,
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

// Pure eligibility gate (ADR-141 decision 14): a top-level (`parent_run_id IS
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

  // A TERMINAL PR can never be reused: re-promotion goes through
  // `createOrUpdatePr`, which finds OPEN PRs only, so reopening onto a
  // merged/closed PR would silently open a SECOND one and break the
  // "re-promotion MUST reuse the SAME provider PR" expectation
  // (docs/system-analytics/branch-sync.md). `pr_state_scan` now clears the
  // conflict flag on a terminal PR (that stale flag was how this became
  // reachable); this refusal is the defense in depth, so a lagging or
  // hand-edited row can never reach the duplicate-PR path.
  if (workspace.prState === "merged" || workspace.prState === "closed") {
    throw new MaisterError(
      "PRECONDITION",
      `reopen requires a reusable PR — this one is ${workspace.prState} and re-promotion would open a second PR`,
    );
  }

  if (!prOpen && !prConflicted) {
    throw new MaisterError(
      "PRECONDITION",
      "reopen requires an open or conflicted PR on the workspace",
    );
  }
}

// Flip a top-level Done run back to Review so its stale/conflicted PR can be
// re-synced and re-promoted (ADR-141). One transaction: `Done->Review` CAS +
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

  try {
    await db.transaction(async (tx: Db) => {
      // Re-assert the PR facts UNDER the workspace lock, on fresh data. The
      // eligibility decision above was made on a lock-free read, and network I/O
      // (fetchRemote + addWorktreeForBranch) has run since — a wide window in which
      // `pr_state_scan`'s merged edge writes these very columns. `markReopenFromDone`
      // re-asserts ONLY `status='Done'` and the workspace UPDATE below carries no PR
      // predicate, so a PR that merged during that window was reopened onto anyway:
      // re-promotion then opens a SECOND PR (`createOrUpdatePr` finds OPEN PRs only),
      // which is exactly what the terminal-PR refusal above exists to prevent.
      // Re-running the pure gate keeps ONE definition of "reusable PR" — a
      // hand-written WHERE would have to re-encode it, and `pr_state` is nullable so
      // an `eq()` predicate would silently never match on the conflicted-only case.
      const [live] = await tx
        .select({
          prState: workspaces.prState,
          prHasConflicts: workspaces.prHasConflicts,
        })
        .from(workspaces)
        .where(eq(workspaces.id, ws.id))
        .for("update");

      if (!live) {
        throw new MaisterError(
          "PRECONDITION",
          `run has no workspace: ${runId}`,
        );
      }

      assertReopenEligible(run, live);

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
  } catch (err) {
    // Compensate the revival: it is a git side effect that already happened, and
    // every throw above is post-attach — the merged-PR re-check (the widest window,
    // and one this very attach opened), the Done CAS, or any DB error.
    //
    // Without this the workspace keeps `removed_at` set — it is cleared INSIDE the
    // tx, so it rolls back too — while its worktree stays attached. Nothing
    // converges that shape: the GC only considers `removed_at IS NULL` workspaces
    // (its mirror-image "pruned but not marked" recovery does not apply) and
    // reconcile skips settled `Done` runs. The retry then re-enters this same
    // revival branch and `addWorktreeForBranch` refuses PRECONDITION — leaving the
    // run unreopenable short of a hand-run `git worktree remove`.
    if (worktreeRevived) {
      await removeWorktree({
        projectRepoPath: ws.parentRepoPath,
        worktreePath: ws.worktreePath,
        force: true,
      }).catch((cleanupErr: unknown) => {
        // Best-effort, and it must NEVER mask the real refusal: the caller needs to
        // know why the reopen was rejected, not that the tidy-up also failed. If it
        // does fail the orphan survives, so say so loudly enough to act on.
        log.warn(
          {
            runId,
            worktreePath: ws.worktreePath,
            branch: ws.branch,
            err:
              cleanupErr instanceof Error
                ? cleanupErr.message
                : String(cleanupErr),
          },
          "[FIX:ADR-141] reopen refused AND the revived worktree could not be removed — it is now orphaned (removed_at set, worktree attached); `git worktree remove` it to make the run reopenable again",
        );
      });
    }

    throw err;
  }

  log.info(
    { runId, worktreeRevived, actor: args.actor.type },
    "run reopened Done -> Review",
  );

  return { status: "Review", worktreeRevived };
}
