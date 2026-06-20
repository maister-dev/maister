import "server-only";

import type { DirtyResolution } from "@/lib/runs/execution-policy";

import { eq, sql } from "drizzle-orm";
import pino from "pino";

import { materializeProjectBundlesIntoWorktree } from "@/lib/capabilities/materialize-bundle";
import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { deleteChatCheckpoint } from "@/lib/flows/graph/workspace-checkpoint";
import {
  discardWorktree,
  snapshotDirtyWorktree,
  statusPorcelain,
} from "@/lib/worktree";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { hitlRequests, runs, workspaces } = schemaModule as unknown as Record<
  string,
  any
>;

// FIXME(any): dual drizzle-orm peer-dep variants.
type Db = any;

const log = pino({
  name: "dirty-resolution",
  level: process.env.LOG_LEVEL ?? "info",
});

export const DIRTY_CHOICES = ["commit", "discard", "proceed"] as const;

export type DirtyChoice = (typeof DIRTY_CHOICES)[number];

export type DirtyFileState = "staged" | "unstaged" | "untracked";

export interface DirtySummary {
  files: Array<{ path: string; states: DirtyFileState[] }>;
  staged: number;
  unstaged: number;
  untracked: number;
  total: number;
}

// C3 (execution-policy dirtyResolve): auto-resolve a dirty worktree AT a review
// gate's creation, per policy. `ask` (supervised default) / a clean tree / a
// missing worktree → no auto-resolution (interactive banner, returns null).
// `commit` → snapshot the dirt into a commit; `proceed` → record it dirty.
// `discard` is NEVER an automatic value (it is destructive — human-only). The
// returned value is written to hitl_requests.dirty_resolution by the caller.
// Best-effort: a git/worktree error leaves the gate interactive (returns null).
export async function autoResolveDirtyAtReview(args: {
  worktreePath: string | null;
  policy: DirtyResolution;
  nodeId: string;
}): Promise<"commit" | "proceed" | null> {
  if (args.policy === "ask" || !args.worktreePath) return null;

  try {
    const porcelain = await statusPorcelain({
      worktreePath: args.worktreePath,
    });

    if (porcelain.trim() === "") return null;

    if (args.policy === "commit") {
      await snapshotDirtyWorktree({
        worktreePath: args.worktreePath,
        commitMessage: `maister: auto-commit dirty worktree before review ${args.nodeId}`,
      });
    }

    log.info(
      { nodeId: args.nodeId, policy: args.policy },
      "[dirty] policy auto-resolved at review gate",
    );

    return args.policy;
  } catch (err) {
    log.warn(
      { nodeId: args.nodeId, err: (err as Error).message },
      "[dirty] policy auto-resolution skipped (git error) — interactive ask",
    );

    return null;
  }
}

// Parse `git status --porcelain=v1 --untracked-files=all` into the review
// payload (ADR-082). XY columns: X = index (staged), Y = working tree
// (unstaged); `??` = untracked. A file can be both staged and unstaged.
export function computeDirtySummary(porcelain: string): DirtySummary {
  const files: Array<{ path: string; states: DirtyFileState[] }> = [];
  let staged = 0;
  let unstaged = 0;
  let untracked = 0;

  for (const line of porcelain.split("\n")) {
    if (line.trim() === "") continue;
    const x = line.charAt(0);
    const y = line.charAt(1);
    // Rename lines are `XY old -> new`; keep the NEW path.
    const rawPath = line.slice(3);
    const path = rawPath.includes(" -> ")
      ? rawPath.slice(rawPath.indexOf(" -> ") + 4)
      : rawPath;
    const states: DirtyFileState[] = [];

    if (x === "?" && y === "?") {
      states.push("untracked");
      untracked += 1;
    } else {
      if (x !== " " && x !== "?") {
        states.push("staged");
        staged += 1;
      }
      if (y !== " " && y !== "?") {
        states.push("unstaged");
        unstaged += 1;
      }
    }

    files.push({ path, states });
  }

  return { files, staged, unstaged, untracked, total: files.length };
}

export interface ResolveDirtyArgs {
  runId: string;
  hitlRequestId: string;
  choice: DirtyChoice;
  db?: Db;
  // Injection point for tests; defaults to the real bundle re-materialization
  // (ADR-079 §4) after a discard's `git clean -fd`.
  rematerialize?: () => Promise<unknown>;
}

// The reviewer's explicit dirty-worktree resolution at an open review-gate
// pause (ADR-082). The gate is NEVER blocked or resolved by this — the choice
// is part of review, recorded write-once on the visit's hitl row.
//
// Order of operations (X-2PC / X-ATOMIC):
//   1. server-state load + precondition checks (no lock, friendly errors)
//   2. write-once CAS claim on dirty_resolution, re-guarded atomically on
//      respondedAt + run status — a concurrent second resolution loses the
//      claim and gets CONFLICT BEFORE any git side-effect runs (a raced
//      `discard` must never destroy work the winner's choice kept)
//   3. git side-effect (commit snapshot / discard+rematerialize / none);
//      a failure rolls the claim back to NULL and rethrows — the gate stays
//      open, no resolution recorded
//   4. chat-baseline invalidation (DD11/DD12 — sensor re-anchors next turn);
//      for `discard` it fires the moment the tree is cleaned, so a failed
//      re-materialization can never leave a baseline that would un-discard
// Crash windows: death between (2) and (3) — or a failed rollback — leaves
// dirty_resolution recorded without the side-effect applied. Non-destructive:
// the gate stays open and the dirty badge keeps reporting live `git status`;
// review proceeds via rework / manual takeover.
export async function resolveDirtyWorktree(
  args: ResolveDirtyArgs,
): Promise<{ choice: DirtyChoice; committed: boolean }> {
  const d = args.db ?? getDb();

  if (!DIRTY_CHOICES.includes(args.choice)) {
    throw new MaisterError(
      "CONFIG",
      `invalid dirty-resolution choice ${JSON.stringify(args.choice)}`,
    );
  }

  const [runRows, hitlRows, workspaceRows] = await Promise.all([
    d.select().from(runs).where(eq(runs.id, args.runId)),
    d
      .select()
      .from(hitlRequests)
      .where(eq(hitlRequests.id, args.hitlRequestId)),
    d.select().from(workspaces).where(eq(workspaces.runId, args.runId)),
  ]);
  const run = runRows[0];
  const hitl = hitlRows[0];
  const workspace = workspaceRows[0];

  if (!run) {
    throw new MaisterError("PRECONDITION", `run not found: ${args.runId}`);
  }
  // X-IDENT: both ids are url-params; the hitl row must belong to the run.
  if (!hitl || hitl.runId !== args.runId) {
    throw new MaisterError(
      "PRECONDITION",
      `hitl request ${args.hitlRequestId} not found for run ${args.runId}`,
    );
  }
  if (hitl.kind !== "human") {
    throw new MaisterError(
      "PRECONDITION",
      `dirty-resolution applies to review-gate (human) pauses, got kind=${hitl.kind}`,
    );
  }
  if (hitl.respondedAt !== null) {
    throw new MaisterError(
      "PRECONDITION",
      `hitl request ${args.hitlRequestId} already responded`,
    );
  }
  if (hitl.dirtyResolution !== null) {
    throw new MaisterError(
      "CONFLICT",
      `dirty-resolution already recorded for this visit (${hitl.dirtyResolution})`,
    );
  }
  if (run.status !== "NeedsInput" && run.status !== "NeedsInputIdle") {
    throw new MaisterError(
      "PRECONDITION",
      `run ${args.runId} not paused at a review gate (status=${run.status})`,
    );
  }
  if (!workspace || workspace.removedAt) {
    throw new MaisterError(
      "PRECONDITION",
      `workspace missing/removed for run ${args.runId}`,
    );
  }

  // Write-once CAS claim — the loser gets CONFLICT before any git side-effect
  // runs. The guards are re-checked atomically inside the UPDATE because the
  // prechecks above are unserialized reads.
  const claimed = await d
    .update(hitlRequests)
    .set({ dirtyResolution: args.choice })
    .where(
      sql`${hitlRequests.id} = ${args.hitlRequestId}
        and ${hitlRequests.dirtyResolution} is null
        and ${hitlRequests.respondedAt} is null
        and exists (
          select 1 from ${runs}
          where ${runs.id} = ${args.runId}
            and ${runs.status} in ('NeedsInput', 'NeedsInputIdle')
        )`,
    )
    .returning({ id: hitlRequests.id });

  if (claimed.length === 0) {
    throw new MaisterError(
      "CONFLICT",
      `dirty-resolution raced — another resolution was recorded for ${args.hitlRequestId}`,
    );
  }

  let committed = false;

  try {
    if (args.choice === "commit") {
      committed = await snapshotDirtyWorktree({
        worktreePath: workspace.worktreePath,
        commitMessage: `wip after node ${hitl.stepId}`,
      });
    } else if (args.choice === "discard") {
      await discardWorktree(workspace.worktreePath);
      // DD12 hard guarantee: the baseline dies the moment the tree is
      // discarded — even if re-materialization fails below, the L3 sensor
      // must never restore the pre-discard baseline (no un-discard).
      await deleteChatCheckpoint(
        workspace.worktreePath,
        args.runId,
        args.hitlRequestId,
      );
      const rematerialize =
        args.rematerialize ??
        (() =>
          materializeProjectBundlesIntoWorktree({
            projectId: run.projectId,
            worktreePath: workspace.worktreePath,
            baseBranch: workspace.baseBranch ?? "main",
            db: d,
          }));

      await rematerialize();
    }

    if (args.choice !== "discard") {
      // DD11/DD12: every executed choice invalidates the gate-chat L3
      // baseline so the sensor re-anchors on the next turn. Best-effort by
      // construction (missing ref is fine).
      await deleteChatCheckpoint(
        workspace.worktreePath,
        args.runId,
        args.hitlRequestId,
      );
    }
  } catch (err) {
    try {
      await d
        .update(hitlRequests)
        .set({ dirtyResolution: null })
        .where(
          sql`${hitlRequests.id} = ${args.hitlRequestId} and ${hitlRequests.dirtyResolution} = ${args.choice}`,
        );
      log.warn(
        {
          runId: args.runId,
          hitlRequestId: args.hitlRequestId,
          choice: args.choice,
          err: err instanceof Error ? err.message : String(err),
        },
        "[dirty] side-effect failed — claim rolled back, gate stays open",
      );
    } catch (rollbackErr) {
      log.error(
        {
          runId: args.runId,
          hitlRequestId: args.hitlRequestId,
          choice: args.choice,
          err:
            rollbackErr instanceof Error
              ? rollbackErr.message
              : String(rollbackErr),
        },
        "[dirty] claim rollback failed — resolution stays recorded without an applied side-effect",
      );
    }
    throw err;
  }

  log.info(
    {
      runId: args.runId,
      hitlRequestId: args.hitlRequestId,
      choice: args.choice,
      committed,
    },
    "[dirty] resolution recorded",
  );

  return { choice: args.choice, committed };
}
