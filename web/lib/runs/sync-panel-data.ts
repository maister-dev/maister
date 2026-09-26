import "server-only";

import { and, desc, eq, notInArray } from "drizzle-orm";

import { loadRunnerCatalog } from "@/lib/acp-runners/catalog";
import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { RUN_SYNC_TERMINAL_PHASES } from "@/lib/db/schema";
import { aheadBehindCounts } from "@/lib/worktree";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { runSyncAttempts } = schemaModule as unknown as Record<string, any>;

// FIXME(any): dual drizzle-orm peer-dep variants.
type Db = any;

export type RunSyncPanelData = {
  aheadBehind: { ahead: number; behind: number } | null;
  sync: {
    runnerOptions: { id: string; label: string }[];
    defaultRunnerId: string | null;
    inProgress: { phase: string } | null;
  };
};

// ADR-141: assemble the review surface's branch-sync props — the
// behind/ahead of the run branch vs its target (git), the resolver runner
// options the git panel's Update section offers in Review (ADR-181 D9), and
// the live in-progress phase off the latest attempt. A git failure degrades
// to null (the chip hides; the panel still offers the update).
export async function buildRunSyncPanelData(input: {
  runId: string;
  parentRepoPath: string;
  branch: string;
  targetBranch: string;
  syncRunnerId: string | null;
  db?: Db;
}): Promise<RunSyncPanelData> {
  const db = (input.db ?? getDb()) as Db;

  let aheadBehind: { ahead: number; behind: number } | null = null;

  try {
    aheadBehind = await aheadBehindCounts(
      input.parentRepoPath,
      input.targetBranch,
      input.branch,
    );
  } catch {
    aheadBehind = null;
  }

  const catalog = await loadRunnerCatalog(db).catch(() => []);
  const runnerOptions = catalog
    .filter((entry: { enabled: boolean }) => entry.enabled)
    .map((entry: { id: string; adapter: string; model: string }) => ({
      id: entry.id,
      label: `${entry.adapter} · ${entry.model}`,
    }));

  const activeRows = await db
    .select({ phase: runSyncAttempts.phase })
    .from(runSyncAttempts)
    .where(
      and(
        eq(runSyncAttempts.runId, input.runId),
        notInArray(runSyncAttempts.phase, [...RUN_SYNC_TERMINAL_PHASES]),
      ),
    )
    .orderBy(desc(runSyncAttempts.attempt))
    .limit(1);

  const inProgress = activeRows[0] ? { phase: activeRows[0].phase } : null;

  return {
    aheadBehind,
    sync: {
      runnerOptions,
      defaultRunnerId: input.syncRunnerId,
      inProgress,
    },
  };
}
