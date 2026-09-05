import "server-only";

import { rm as fsRm } from "node:fs/promises";
import path from "node:path";

import { and, eq, inArray, isNull } from "drizzle-orm";
import pino from "pino";

import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { restoreAgentMaterialization } from "@/lib/agents/dirty-watchdog";
import { assertSafeAgentMaterializationPath } from "@/lib/agents/materialization-manifest";
import { capabilityMaterializationRootPath } from "@/lib/capabilities/materialize";
import { reclaimCapabilitySettings } from "@/lib/capabilities/settings-ownership";
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
  const relativeDir = path.relative(path.resolve(args.worktreePath), dir);
  const nowIso = new Date().toISOString();

  let removed = false;
  let error: string | undefined;

  try {
    const safeWorktreePath = await assertSafeAgentMaterializationPath(
      args.worktreePath,
      relativeDir,
    );
    const safeDir = path.join(safeWorktreePath, relativeDir);

    await (args.rm ?? fsRm)(safeDir, { recursive: true, force: true });
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

// Restores a capability-owned settings file only when the marker names this
// exact run. A foreign or malformed marker is a retryable ownership conflict,
// never permission to delete another session's settings.
export async function reclaimWorktreeSettings(args: {
  worktreePath: string;
  runId: string;
}): Promise<{ reclaimed: boolean; retryable: boolean }> {
  const result = await reclaimCapabilitySettings({
    cwd: args.worktreePath,
    runId: args.runId,
  });

  if (result.status === "reclaimed" || result.status === "absent") {
    return { reclaimed: result.status === "reclaimed", retryable: false };
  }

  log.error(
    {
      worktreePath: args.worktreePath,
      runId: args.runId,
      result,
    },
    "settings.local.json reclaim deferred for retry",
  );

  return { reclaimed: false, retryable: true };
}

// Clean every plan-bearing node and every lease-owned direct artifact of a run.
// `restoreAgentMaterialization` is the sole owner of capability-settings
// reclamation because it first verifies that this run owns the profile lease.
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

  try {
    await restoreAgentMaterialization(args.worktreePath, args.runId);
  } catch (err) {
    failed += 1;
    log.error(
      {
        runId: args.runId,
        worktreePath: args.worktreePath,
        err: err instanceof Error ? err.message : String(err),
      },
      "lease-owned capability cleanup failed; record retained for retry",
    );
  }

  return { cleaned, failed };
}

// Cron sweep: scan terminal runs whose workspace is still on disk (removed_at IS
// NULL) and clean their per-node capability dirs. Broader than workspace-gc
// loadCandidates (which only scans Abandoned/Done past their deadline) — this
// reclaims capability dirs the moment a run reaches any terminal state. The
// whole sweep is bulletproof: each run is cleaned inside a try/catch. Crashed
// agent worktrees and scratch worktrees remain recovery-owned and are
// deliberately skipped.
export async function runCapabilitiesCleanupSweep(opts?: {
  db?: Db;
  rm?: typeof fsRm;
}): Promise<{ scanned: number; cleaned: number; failed: number }> {
  const d = opts?.db ?? getDb();

  const rows: Array<{
    runId: string;
    worktreePath: string;
    runKind: string;
    status: string;
    agentWorkspace: string | null;
  }> = await d
    .select({
      runId: workspaces.runId,
      worktreePath: workspaces.worktreePath,
      runKind: runs.runKind,
      status: runs.status,
      agentWorkspace: runs.agentWorkspace,
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
    const preservesRecoveryMaterialization =
      row.status === "Crashed" &&
      (row.runKind === "scratch" ||
        (row.runKind === "agent" && row.agentWorkspace === "worktree"));

    if (preservesRecoveryMaterialization) {
      log.info(
        {
          runId: row.runId,
          runKind: row.runKind,
          worktreePath: row.worktreePath,
        },
        "capabilities cleanup sweep skipped resumable crashed worktree",
      );
      continue;
    }

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
