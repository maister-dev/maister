import "server-only";

import { desc, eq } from "drizzle-orm";

import { loadRunnerCatalog } from "@/lib/acp-runners/catalog";
import { getDb } from "@/lib/db/client";
import { RUN_SYNC_TERMINAL_PHASES, runSyncAttempts } from "@/lib/db/schema";
import { aheadBehindCounts } from "@/lib/worktree";

type RunSyncAttemptFields = Pick<
  typeof runSyncAttempts.$inferSelect,
  | "id"
  | "attempt"
  | "strategy"
  | "phase"
  | "targetRef"
  | "targetSha"
  | "headShaBefore"
  | "headShaAfter"
  | "sessionName"
  | "runnerId"
  | "conflictedFiles"
  | "pushed"
  | "errorCode"
>;

export type RunSyncAttemptView = RunSyncAttemptFields & { settled: boolean };

export async function loadLatestRunSyncAttempt(
  runId: string,
): Promise<RunSyncAttemptView | null> {
  const [latest] = await getDb()
    .select({
      id: runSyncAttempts.id,
      attempt: runSyncAttempts.attempt,
      strategy: runSyncAttempts.strategy,
      phase: runSyncAttempts.phase,
      targetRef: runSyncAttempts.targetRef,
      targetSha: runSyncAttempts.targetSha,
      headShaBefore: runSyncAttempts.headShaBefore,
      headShaAfter: runSyncAttempts.headShaAfter,
      sessionName: runSyncAttempts.sessionName,
      runnerId: runSyncAttempts.runnerId,
      conflictedFiles: runSyncAttempts.conflictedFiles,
      pushed: runSyncAttempts.pushed,
      errorCode: runSyncAttempts.errorCode,
    })
    .from(runSyncAttempts)
    .where(eq(runSyncAttempts.runId, runId))
    .orderBy(desc(runSyncAttempts.attempt))
    .limit(1);

  return latest
    ? {
        ...latest,
        settled: RUN_SYNC_TERMINAL_PHASES.some(
          (phase) => phase === latest.phase,
        ),
      }
    : null;
}

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
  parentRepoPath: string;
  branch: string;
  targetBranch: string;
  syncRunnerId: string | null;
  inProgress: RunSyncPanelData["sync"]["inProgress"];
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

  return {
    aheadBehind,
    sync: {
      runnerOptions,
      defaultRunnerId: input.syncRunnerId,
      inProgress: input.inProgress,
    },
  };
}
