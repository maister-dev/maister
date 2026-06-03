import "server-only";

import { access, copyFile, rm as fsRm } from "node:fs/promises";
import path from "node:path";

import { and, eq, inArray, isNull } from "drizzle-orm";
import pino from "pino";

import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { capabilityMaterializationRootPath } from "@/lib/capabilities/materialize";
import {
  getNodeAttemptsForRun,
  updateMaterializationCleanup,
} from "@/lib/flows/graph/ledger";

// FIXME(any): dual drizzle-orm peer-dep variants (matches catalog.ts/resolver.ts).
const { runs, workspaces } = schemaModule as unknown as Record<string, any>;

// FIXME(any): dual drizzle-orm peer-dep variants.
type Db = any;

const log = pino({
  name: "capabilities-cleanup",
  level: process.env.LOG_LEVEL ?? "info",
});

// R-DEFER: best-effort removal of ONE node's materialized capability dir. NEVER
// throws — every await is wrapped so a sweep over many nodes is bulletproof. The
// rm and the cleanup-status write fail independently; either failure is logged
// and recorded (failed status) without propagating.
export async function cleanupNodeMaterialization(args: {
  nodeAttemptId: string;
  runId: string;
  worktreePath: string;
  db?: Db;
  rm?: typeof fsRm;
}): Promise<{ removed: boolean }> {
  const dir = capabilityMaterializationRootPath(
    args.worktreePath,
    args.runId,
    args.nodeAttemptId,
  );
  const nowIso = new Date().toISOString();

  let removed = false;
  let error: string | undefined;

  try {
    await (args.rm ?? fsRm)(dir, { recursive: true, force: true });
    removed = true;
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    log.error(
      { nodeAttemptId: args.nodeAttemptId, runId: args.runId, dir, err: error },
      "capability-dir cleanup: rm failed",
    );
  }

  try {
    await updateMaterializationCleanup(
      args.nodeAttemptId,
      removed
        ? { status: "done", at: nowIso }
        : { status: "failed", error, at: nowIso },
      args.db,
    );
  } catch (err) {
    log.error(
      {
        nodeAttemptId: args.nodeAttemptId,
        runId: args.runId,
        err: err instanceof Error ? err.message : String(err),
      },
      "capability-dir cleanup: recording cleanup status failed",
    );
  }

  return { removed };
}

// R-DEFER: worktree-level reclaim of `<worktree>/.claude/settings.local.json`.
// Done ONCE per run (not per node), since the file is a single shared worktree
// resource. If a `.maister-bak` exists, the user had an original — restore it
// and drop the bak; otherwise remove the M14-created file. NEVER throws.
//
// Limitation: a repo that COMMITS `.claude/settings.local.json` (an anti-pattern
// — it is meant to be local/gitignored) and runs a flow firing multiple
// run-terminal cleanups could have its restored original re-removed by a later
// reclaim; settings.local.json is treated as local/ephemeral here.
export async function reclaimWorktreeSettings(
  worktreePath: string,
  rm: typeof fsRm = fsRm,
): Promise<{ reclaimed: boolean }> {
  const target = path.join(worktreePath, ".claude", "settings.local.json");
  const bak = `${target}.maister-bak`;

  try {
    if (await pathExists(bak)) {
      await copyFile(bak, target);
      await rm(bak, { force: true });

      return { reclaimed: true };
    }

    if (await pathExists(target)) {
      await rm(target, { force: true });

      return { reclaimed: true };
    }

    return { reclaimed: false };
  } catch (err) {
    log.error(
      {
        worktreePath,
        target,
        err: err instanceof Error ? err.message : String(err),
      },
      "settings.local.json reclaim failed",
    );

    return { reclaimed: false };
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);

    return true;
  } catch {
    return false;
  }
}

// Clean every plan-bearing node of a run, then reclaim the worktree-level
// settings.local.json ONCE. Loops cleanupNodeMaterialization (which never
// throws) and tallies. NEVER throws.
export async function cleanupRunMaterializations(args: {
  runId: string;
  worktreePath: string;
  db?: Db;
  rm?: typeof fsRm;
}): Promise<{ cleaned: number; failed: number }> {
  const attempts = (await getNodeAttemptsForRun(args.runId, args.db)).filter(
    (a) => a.materializationPlan != null,
  );

  let cleaned = 0;
  let failed = 0;

  for (const attempt of attempts) {
    const { removed } = await cleanupNodeMaterialization({
      nodeAttemptId: attempt.id,
      runId: args.runId,
      worktreePath: args.worktreePath,
      db: args.db,
      rm: args.rm,
    });

    if (removed) cleaned += 1;
    else failed += 1;
  }

  await reclaimWorktreeSettings(args.worktreePath, args.rm);

  return { cleaned, failed };
}

// Cron sweep: scan terminal runs whose workspace is still on disk (removed_at IS
// NULL) and clean their per-node capability dirs. Broader than workspace-gc
// loadCandidates (which only scans Abandoned/Done past their deadline) — this
// reclaims capability dirs the moment a run reaches any terminal state. The
// whole sweep is bulletproof: each run is cleaned inside a try/catch.
export async function runCapabilitiesCleanupSweep(opts?: {
  db?: Db;
  rm?: typeof fsRm;
}): Promise<{ scanned: number; cleaned: number; failed: number }> {
  const d = opts?.db ?? getDb();

  const rows: Array<{ runId: string; worktreePath: string }> = await d
    .select({
      runId: workspaces.runId,
      worktreePath: workspaces.worktreePath,
    })
    .from(workspaces)
    .innerJoin(runs, eq(runs.id, workspaces.runId))
    .where(
      and(
        isNull(workspaces.removedAt),
        inArray(runs.status, ["Abandoned", "Done", "Failed", "Crashed"]),
      ),
    )
    .limit(200);

  let cleaned = 0;
  let failed = 0;

  for (const row of rows) {
    try {
      const res = await cleanupRunMaterializations({
        runId: row.runId,
        worktreePath: row.worktreePath,
        db: d,
        rm: opts?.rm,
      });

      cleaned += res.cleaned;
      failed += res.failed;
    } catch (err) {
      log.error(
        {
          runId: row.runId,
          err: err instanceof Error ? err.message : String(err),
        },
        "capabilities cleanup sweep: run failed — continuing",
      );
    }
  }

  log.info(
    { scanned: rows.length, cleaned, failed },
    "capabilities cleanup sweep complete",
  );

  return { scanned: rows.length, cleaned, failed };
}
