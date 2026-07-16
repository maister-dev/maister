import "server-only";

import { readdir } from "node:fs/promises";
import path from "node:path";

import { inArray } from "drizzle-orm";
import pino from "pino";

import { restoreAgentMaterialization } from "@/lib/agents/dirty-watchdog";
import { listAgentMaterializationRunIds } from "@/lib/agents/materialization-manifest";
import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { worktreesRoot } from "@/lib/instance-config";

const {
  localPackages,
  projects,
  runs,
  workspaces,
} = schemaModule;

type SelectQuery = PromiseLike<unknown> & {
  where(condition: unknown): Promise<unknown>;
};

type Db = {
  select(fields: unknown): {
    from(table: unknown): SelectQuery;
  };
};

const TERMINAL_CLEANUP_STATUSES = new Set(["Done", "Failed", "Abandoned"]);

const log = pino({
  name: "gc-agent-materialization",
  level: process.env.LOG_LEVEL ?? "info",
});

export type AgentMaterializationGcSummary = {
  readonly scanned: number;
  readonly restored: number;
  readonly live: number;
  readonly failed: number;
};

export type AgentMaterializationRunCleanupState = {
  readonly status: string;
  readonly agentWorkspace: string | null;
};

export type RunAgentMaterializationCleanupSweepOptions = {
  readonly db?: Db;
  readonly candidateRoots?: readonly string[];
  readonly loadStatuses?: (
    runIds: readonly string[],
  ) => Promise<ReadonlyMap<string, AgentMaterializationRunCleanupState>>;
  readonly restore?: (cwd: string, runId: string) => Promise<void>;
};

export async function discoverAgentMaterializationCandidateRoots(
  db: Db,
): Promise<string[]> {
  const [projectRows, workspaceRows, localPackageRows] = (await Promise.all([
    db
      .select({ slug: projects.slug, repoPath: projects.repoPath })
      .from(projects),
    db.select({ worktreePath: workspaces.worktreePath }).from(workspaces),
    db.select({ workingDir: localPackages.workingDir }).from(localPackages),
  ])) as unknown as [
    Array<{ readonly slug: string; readonly repoPath: string }>,
    Array<{ readonly worktreePath: string }>,
    Array<{ readonly workingDir: string }>,
  ];
  const roots = new Set<string>([
    ...projectRows.map((row) => path.resolve(row.repoPath)),
    ...workspaceRows.map((row) => path.resolve(row.worktreePath)),
    ...localPackageRows.map((row) => path.resolve(row.workingDir)),
  ]);
  const worktreeBase = worktreesRoot();

  for (const project of projectRows) {
    const projectRoot = path.join(worktreeBase, project.slug);

    try {
      const entries = await readdir(projectRoot, { withFileTypes: true });

      for (const entry of entries) {
        if (entry.isDirectory() && !entry.isSymbolicLink()) {
          roots.add(path.join(projectRoot, entry.name));
        }
      }
    } catch (err) {
      if (
        typeof err !== "object" ||
        err === null ||
        !("code" in err) ||
        (err as { readonly code?: unknown }).code !== "ENOENT"
      ) {
        throw err;
      }
    }
  }

  return [...roots].sort();
}

async function loadRunStatuses(
  db: Db,
  runIds: readonly string[],
): Promise<ReadonlyMap<string, AgentMaterializationRunCleanupState>> {
  if (runIds.length === 0) return new Map();

  const rows = (await db
    .select({
      id: runs.id,
      status: runs.status,
      agentWorkspace: runs.agentWorkspace,
    })
    .from(runs)
    .where(inArray(runs.id, [...runIds]))) as Array<{
    readonly id: string;
    readonly status: string;
    readonly agentWorkspace: string | null;
  }>;

  return new Map(
    rows.map((row) => [
      row.id,
      { status: row.status, agentWorkspace: row.agentWorkspace },
    ]),
  );
}

function shouldRestoreMaterialization(
  state: AgentMaterializationRunCleanupState | undefined,
): boolean {
  if (!state) return true;
  if (TERMINAL_CLEANUP_STATUSES.has(state.status)) return true;

  // A crashed worktree can be resumed. Crashed none/repo_read sessions have no
  // recoverable workspace and must retry their post-commit materialization
  // release; unknown historical rows stay conservative and are preserved.
  return (
    state.status === "Crashed" &&
    (state.agentWorkspace === "none" || state.agentWorkspace === "repo_read")
  );
}

export async function runAgentMaterializationCleanupSweep(
  opts: RunAgentMaterializationCleanupSweepOptions = {},
): Promise<AgentMaterializationGcSummary> {
  const resolveDb = (): Db =>
    (opts.db ?? getDb()) as unknown as Db;
  const roots = opts.candidateRoots
    ? [...new Set(opts.candidateRoots.map((root) => path.resolve(root)))].sort()
    : await discoverAgentMaterializationCandidateRoots(resolveDb());
  const candidates: Array<{ readonly cwd: string; readonly runId: string }> =
    [];
  let failed = 0;

  for (const cwd of roots) {
    try {
      const runIds = await listAgentMaterializationRunIds(cwd);

      candidates.push(...runIds.map((runId) => ({ cwd, runId })));
    } catch (err) {
      failed += 1;
      log.error(
        { errorType: err instanceof Error ? err.name : "unknown" },
        "agent materialization cleanup candidate discovery failed",
      );
    }
  }

  const runIds = [...new Set(candidates.map((candidate) => candidate.runId))];
  const statuses = opts.loadStatuses
    ? await opts.loadStatuses(runIds)
    : await loadRunStatuses(resolveDb(), runIds);
  const restore = opts.restore ?? restoreAgentMaterialization;
  let restored = 0;
  let live = 0;

  for (const candidate of candidates) {
    const state = statuses.get(candidate.runId);

    if (!shouldRestoreMaterialization(state)) {
      live += 1;
      continue;
    }

    try {
      await restore(candidate.cwd, candidate.runId);
      restored += 1;
    } catch (err) {
      failed += 1;
      log.error(
        {
          runId: candidate.runId,
          status: state?.status ?? "missing",
          agentWorkspace: state?.agentWorkspace ?? null,
          errorType: err instanceof Error ? err.name : "unknown",
        },
        "agent materialization cleanup failed; ownership record retained for retry",
      );
    }
  }

  const summary = { scanned: candidates.length, restored, live, failed };

  log.info(summary, "agent materialization cleanup sweep completed");

  return summary;
}
