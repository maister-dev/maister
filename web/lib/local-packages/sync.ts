import "server-only";

import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { LocalPackage, LocalPackageSyncState } from "@/lib/db/schema";

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { eq } from "drizzle-orm";
import pino from "pino";

import { loadInstallDir } from "./divergence";
import {
  ensureLocalPackageGitExclude,
  gitCommitWorkingDir,
  gitDiscardPaths,
} from "./git";
import {
  acquireWorkingDirLock,
  assertHoldsLock,
  releaseWorkingDirLock,
} from "./lock";
import { getLocalPackage } from "./service";
import { mergeTrees } from "./sync-merge";

import { getDb } from "@/lib/db/client";
import * as schema from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { diffWorkingTree } from "@/lib/worktree";

const log = pino({
  name: "local-packages/sync",
  level: process.env.LOG_LEVEL ?? "info",
});

type Db = NodePgDatabase<typeof schema>;

function resolveDb(db?: Db): Db {
  return db ?? (getDb() as unknown as Db);
}

const lp = schema.localPackages;

export type SyncResult = {
  outcome: "clean" | "conflicted" | "completed";
  conflictedFiles: string[];
  targetInstallId: string;
  targetRef: string;
};

// ADR-132 §d: the upstream sync is merge-shaped (fork commits are NEVER
// rewritten) and `sync_state` is the single crash-window discriminant:
//   pending + clean tree  → the merge never wrote (window 1) → Resume = the
//                           idempotent same-target re-POST of /sync.
//   pending + dirty tree  → the merge wrote (window 2) → Resolve validates +
//                           completes, or Abort resets. No sweeper touches
//                           this — recovery is user-driven from the banner.
// Order of operations: (1) tx persist sync_state BEFORE any disk write →
// (2) mergeTrees into the working dir → (3) clean: at most ONE commit (a
// no-change merge skips it), then ONE tx advancing source_install_id/
// source_ref + clearing sync_state → (4) conflict: tx stamps
// conflictedFiles; markers stay uncommitted.

async function loadActivePackage(
  d: Db,
  localPackageId: string,
): Promise<LocalPackage> {
  const pkg = await getLocalPackage(localPackageId, d);

  if (!pkg || pkg.status !== "active") {
    throw new MaisterError("PRECONDITION", "local package not found");
  }

  return pkg;
}

async function workingTreeDirtyPaths(workingDir: string): Promise<string[]> {
  // Prime the runtime excludes so .maister/.claude materializations never
  // read as dirtiness (diffWorkingDir idiom).
  await ensureLocalPackageGitExclude(workingDir);
  const wt = await diffWorkingTree(workingDir);

  return wt.nameStatus.map((entry) => entry.path);
}

export async function syncFromUpstream(opts: {
  localPackageId: string;
  targetInstallId: string;
  sessionId: string;
  db?: Db;
}): Promise<SyncResult> {
  const d = resolveDb(opts.db);
  let pkg = await loadActivePackage(d, opts.localPackageId);

  await assertHoldsLock(pkg.id, opts.sessionId, d);

  // ADR-132 (C3): serialize every working-dir mutation on this package. The
  // editor lock is not a mutex (same session passes twice), so a double-submit
  // could run two 3-way merges over one working dir. Re-read pkg UNDER the lock
  // so the sync_state/dirty decision is TOCTOU-safe.
  const lockToken = await acquireWorkingDirLock(pkg.id, d);

  try {
    pkg = await loadActivePackage(d, opts.localPackageId);

    if (!pkg.sourceInstallId) {
      throw new MaisterError(
        "CONFIG",
        "source install unavailable: this package has no upstream lineage",
      );
    }

    const pending = pkg.syncState;

    if (pending && pending.targetInstallId !== opts.targetInstallId) {
      throw new MaisterError(
        "CONFLICT",
        `sync in progress towards ${pending.targetRef} — resolve or abort it first`,
      );
    }

    const dirtyPaths = await workingTreeDirtyPaths(pkg.workingDir);

    if (pending && dirtyPaths.length > 0) {
      // Crash window 2 (merge already wrote) — same-target Resume applies only
      // to window 1 (clean tree). Completing/undoing is Resolve/Abort's job.
      throw new MaisterError(
        "CONFLICT",
        "sync in progress with merged content in the working tree — resolve or abort it",
      );
    }
    if (!pending && dirtyPaths.length > 0) {
      throw new MaisterError(
        "PRECONDITION",
        "commit or discard working-tree changes before syncing",
        { details: { changedCount: dirtyPaths.length } },
      );
    }

    // base = the fork's ORIGINAL lineage install; theirs = the target.
    const base = await loadInstallDir(d, pkg.sourceInstallId, "source install");
    const target = await loadInstallDir(
      d,
      opts.targetInstallId,
      "target install",
    );
    const targetRow = target.row as {
      name?: string;
      sourceUrl?: string;
      packageStatus?: string;
    };
    const baseRow = base.row as { name?: string; sourceUrl?: string };

    if (
      targetRow.packageStatus !== "Installed" ||
      targetRow.name !== baseRow.name ||
      targetRow.sourceUrl !== baseRow.sourceUrl
    ) {
      throw new MaisterError(
        "CONFLICT",
        `target install ${opts.targetInstallId} is not an Installed version of the lineage package (${baseRow.name ?? "?"} @ ${baseRow.sourceUrl ?? "?"})`,
      );
    }

    const targetRef = target.versionLabel;
    const syncState: LocalPackageSyncState = pending ?? {
      targetInstallId: opts.targetInstallId,
      targetRef,
      conflictedFiles: [],
      startedAt: new Date().toISOString(),
    };

    // Phase 1: durable intent BEFORE any disk write.
    await d
      .update(lp)
      .set({ syncState, updatedAt: new Date() })
      .where(eq(lp.id, pkg.id));

    // Phase 2: disk merge (idempotent — a window-1 Resume re-runs on identical
    // inputs; the case table converges).
    const merged = await mergeTrees({
      baseDir: base.installedPath,
      theirsDir: target.installedPath,
      oursDir: pkg.workingDir,
      markerLabel: `upstream ${targetRef}`,
    });

    if (merged.conflictedFiles.length > 0) {
      await d
        .update(lp)
        .set({
          syncState: { ...syncState, conflictedFiles: merged.conflictedFiles },
          updatedAt: new Date(),
        })
        .where(eq(lp.id, pkg.id));

      log.info(
        {
          id: pkg.id,
          targetRef,
          conflicts: merged.conflictedFiles.length,
          clean: merged.cleanFiles.length,
        },
        "upstream sync conflicted",
      );

      return {
        outcome: "conflicted",
        conflictedFiles: merged.conflictedFiles,
        targetInstallId: opts.targetInstallId,
        targetRef,
      };
    }

    // Phase 3 (clean): at most one commit — a no-change merge skips it.
    if (merged.cleanFiles.length > 0) {
      await gitCommitWorkingDir(
        pkg.workingDir,
        `Sync from upstream ${targetRef}`,
      );
    }
    await d
      .update(lp)
      .set({
        sourceInstallId: opts.targetInstallId,
        sourceRef: targetRef,
        syncState: null,
        updatedAt: new Date(),
      })
      .where(eq(lp.id, pkg.id));

    log.info(
      {
        id: pkg.id,
        targetRef,
        changed: merged.cleanFiles.length,
        committed: merged.cleanFiles.length > 0,
      },
      "upstream sync completed clean",
    );

    return {
      outcome: "clean",
      conflictedFiles: [],
      targetInstallId: opts.targetInstallId,
      targetRef,
    };
  } finally {
    await releaseWorkingDirLock(pkg.id, lockToken, d).catch(() => undefined);
  }
}

// Entry/exit conflict markers only — a bare `=======` line is a legal
// markdown heading underline inside package docs.
const CONFLICT_MARKER = /^(<{7}( |$)|>{7}( |$))/m;

export async function resolveSync(opts: {
  localPackageId: string;
  sessionId: string;
  commitMessage?: string;
  db?: Db;
}): Promise<SyncResult> {
  const d = resolveDb(opts.db);
  let pkg = await loadActivePackage(d, opts.localPackageId);

  await assertHoldsLock(pkg.id, opts.sessionId, d);

  const lockToken = await acquireWorkingDirLock(pkg.id, d);

  try {
    pkg = await loadActivePackage(d, opts.localPackageId);

    const pending = pkg.syncState;

    if (!pending) {
      // Idempotent retry after a completed resolve: lineage advanced, state
      // cleared → report completion against the CURRENT lineage.
      return {
        outcome: "completed",
        conflictedFiles: [],
        targetInstallId: pkg.sourceInstallId ?? "",
        targetRef: pkg.sourceRef ?? "",
      };
    }

    const dirtyPaths = await workingTreeDirtyPaths(pkg.workingDir);

    if (pending.conflictedFiles.length === 0 && dirtyPaths.length === 0) {
      // Crash window 1: intent persisted, merge never wrote — nothing to
      // resolve; Resume (same-target /sync) is the correct recovery.
      throw new MaisterError(
        "PRECONDITION",
        "nothing to resolve — resume the sync (re-run it towards the same target)",
      );
    }

    // Marker scan over the UNION of the listed files' CURRENT bytes and every
    // dirty file — the stamped list alone is not the boundary (the user may
    // have copied markers around while editing).
    const scanPaths = [
      ...new Set([...pending.conflictedFiles, ...dirtyPaths]),
    ].sort();

    for (const rel of scanPaths) {
      let text: string;

      try {
        text = await readFile(join(pkg.workingDir, rel), "utf8");
      } catch {
        continue; // deleted while resolving — nothing to scan
      }
      if (CONFLICT_MARKER.test(text)) {
        throw new MaisterError(
          "PRECONDITION",
          `conflict markers remain in ${rel}`,
          { details: { file: rel } },
        );
      }
    }

    if (dirtyPaths.length > 0) {
      await gitCommitWorkingDir(
        pkg.workingDir,
        opts.commitMessage ?? `Resolve sync from upstream ${pending.targetRef}`,
      );
    }

    // The SAME single transaction as the clean case: advance lineage + clear.
    await d
      .update(lp)
      .set({
        sourceInstallId: pending.targetInstallId,
        sourceRef: pending.targetRef,
        syncState: null,
        updatedAt: new Date(),
      })
      .where(eq(lp.id, pkg.id));

    log.info(
      { id: pkg.id, targetRef: pending.targetRef, resolved: scanPaths.length },
      "upstream sync resolved",
    );

    return {
      outcome: "completed",
      conflictedFiles: [],
      targetInstallId: pending.targetInstallId,
      targetRef: pending.targetRef,
    };
  } finally {
    await releaseWorkingDirLock(pkg.id, lockToken, d).catch(() => undefined);
  }
}

export async function abortSync(opts: {
  localPackageId: string;
  sessionId: string;
  db?: Db;
}): Promise<void> {
  const d = resolveDb(opts.db);
  let pkg = await loadActivePackage(d, opts.localPackageId);

  await assertHoldsLock(pkg.id, opts.sessionId, d);

  const lockToken = await acquireWorkingDirLock(pkg.id, d);

  try {
    pkg = await loadActivePackage(d, opts.localPackageId);

    if (!pkg.syncState) {
      // Idempotent: a completed or already-aborted sync has no pending state —
      // a retried abort is a no-op success (mirrors resolveSync's no-pending
      // branch), not a 409.
      return;
    }

    // The tree was clean pre-merge (a /sync precondition), so restoring HEAD +
    // dropping untracked merge additions loses nothing user-authored. Fork
    // commits are never rewritten. Narrow self-healing edge: if a crash landed
    // the post-merge commit but not the lineage advance, the clean tree makes
    // discard a no-op and the commit stays — the next sync is a no-change merge
    // that advances lineage.
    const targetRef = pkg.syncState.targetRef;

    await gitDiscardPaths(pkg.workingDir);
    await d
      .update(lp)
      .set({ syncState: null, updatedAt: new Date() })
      .where(eq(lp.id, pkg.id));

    log.info({ id: pkg.id, targetRef }, "upstream sync aborted");
  } finally {
    await releaseWorkingDirLock(pkg.id, lockToken, d).catch(() => undefined);
  }
}
