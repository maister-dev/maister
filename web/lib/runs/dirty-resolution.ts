import "server-only";

import { eq, sql } from "drizzle-orm";
import pino from "pino";

import { materializeProjectBundlesIntoWorktree } from "@/lib/capabilities/materialize-bundle";
import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { deleteChatCheckpoint } from "@/lib/flows/graph/workspace-checkpoint";
import { discardWorktree, snapshotDirtyWorktree } from "@/lib/worktree";

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

// Parse `git status --porcelain=v1 --untracked-files=all` into the review
// payload (ADR-079). XY columns: X = index (staged), Y = working tree
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
  // (ADR-076 §4) after a discard's `git clean -fd`.
  rematerialize?: () => Promise<unknown>;
}

// The reviewer's explicit dirty-worktree resolution at an open review-gate
// pause (ADR-079). The gate is NEVER blocked or resolved by this — the choice
// is part of review, recorded write-once on the visit's hitl row.
//
// Order of operations (X-2PC / X-ATOMIC):
//   1. server-state load + precondition checks (no lock)
//   2. git side-effect (commit snapshot / discard+rematerialize / none)
//   3. chat-baseline invalidation (DD11/DD12 — sensor re-anchors next turn)
//   4. one transaction: write-once CAS on dirty_resolution (idempotency
//      marker AFTER the side-effect) — a concurrent second resolution loses
//      the CAS and gets CONFLICT.
// Crash windows: after (2)/(3) but before (4) → dirty_resolution stays NULL;
// a retry re-runs (2) idempotently (snapshot on a clean tree is a no-op,
// discard is idempotent, proceed has no side-effect).
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

  let committed = false;

  if (args.choice === "commit") {
    committed = await snapshotDirtyWorktree({
      worktreePath: workspace.worktreePath,
      commitMessage: `wip after node ${hitl.stepId}`,
    });
  } else if (args.choice === "discard") {
    await discardWorktree(workspace.worktreePath);
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

  // DD11/DD12: every executed choice invalidates the gate-chat L3 baseline so
  // the sensor re-anchors on the next turn (never un-discards a Discard).
  // Best-effort by construction (missing ref is fine).
  await deleteChatCheckpoint(
    workspace.worktreePath,
    args.runId,
    args.hitlRequestId,
  );

  // Write-once CAS — the idempotency marker lands AFTER the side-effect.
  const updated = await d
    .update(hitlRequests)
    .set({ dirtyResolution: args.choice })
    .where(
      sql`${hitlRequests.id} = ${args.hitlRequestId} and ${hitlRequests.dirtyResolution} is null`,
    )
    .returning({ id: hitlRequests.id });

  if (updated.length === 0) {
    throw new MaisterError(
      "CONFLICT",
      `dirty-resolution raced — another resolution was recorded for ${args.hitlRequestId}`,
    );
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
