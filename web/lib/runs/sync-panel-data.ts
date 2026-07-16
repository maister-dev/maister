import "server-only";

import { and, desc, eq, notInArray } from "drizzle-orm";

import { loadRunnerCatalog } from "@/lib/acp-runners/catalog";
import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { RUN_SYNC_TERMINAL_PHASES } from "@/lib/db/schema";
import { isBranchPublished } from "@/lib/runs/branch-published";
import { aheadBehindCounts } from "@/lib/worktree";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { runSyncAttempts } = schemaModule as unknown as Record<string, any>;

// FIXME(any): dual drizzle-orm peer-dep variants.
type Db = any;

export type RunSyncPanelData = {
  aheadBehind: { ahead: number; behind: number } | null;
  sync: {
    strategyDefault: "rebase" | "merge";
    runnerOptions: { id: string; label: string }[];
    defaultRunnerId: string | null;
    published: boolean;
    inProgress: { phase: string } | null;
  };
};

// ADR-140 (Task 16): assemble the ReviewPanel branch-sync props — the
// behind/ahead of the run branch vs its target (git), the dialog seed (project
// strategy default + resolver runner options + published-ness), and the live
// in-progress phase off the latest attempt. Git failures degrade to null/false
// (the chip hides, the dialog still offers a sync).
export async function buildRunSyncPanelData(input: {
  runId: string;
  parentRepoPath: string;
  branch: string;
  targetBranch: string;
  syncStrategyDefault: "rebase" | "merge";
  syncRunnerId: string | null;
  prUrl: string | null;
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

  let published = false;

  try {
    // THE shared predicate — the checkbox this seeds is consumed as
    // `input.push ?? published`, so reading anything narrower than what the push
    // path reads silently drops the push.
    published = await isBranchPublished({
      prUrl: input.prUrl,
      repo: input.parentRepoPath,
      branch: input.branch,
    });
  } catch {
    published = false;
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
      strategyDefault: input.syncStrategyDefault,
      runnerOptions,
      defaultRunnerId: input.syncRunnerId,
      published,
      inProgress,
    },
  };
}
