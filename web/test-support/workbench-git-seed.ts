import { randomUUID } from "node:crypto";

import * as fullSchema from "@/lib/db/schema";

// FIXME(any): dual drizzle-orm peer-dep variants — the suites pass a
// Testcontainers client; rows are written through the schema tables.
type Db = any;

const schema = fullSchema as unknown as Record<string, any>;

export type WorkbenchRunSeed = {
  parentRepoPath: string;
  worktreePath: string;
  branch: string;
  baseCommit?: string | null;
  status?: string;
  runKind?: "flow" | "agent" | "scratch";
  taskKey?: string;
  // null → a task-less run (no `tasks` row).
  task?: { number: number; title: string } | null;
  publicBranchTemplate?: string;
  targetBranch?: string | null;
  baseBranch?: string | null;
  published?: { branch: string; remote: string; at?: Date } | null;
  prUrl?: string | null;
  prNumber?: number | null;
  prState?: "open" | "merged" | "closed" | null;
  promotionState?: string;
  removedAt?: Date | null;
  archivedBranch?: string | null;
  workspaceMode?: "own" | "shared" | null;
  parentRunId?: string | null;
  // The allocator of a shared writable tree (ADR-102): `shared` + `worktree`,
  // rooted at itself, so siblings join it by `root_run_id = runId`.
  sharedTreeAllocator?: boolean;
  // Required for `runKind: "scratch"`: no production writer creates a scratch
  // run without its `scratch_runs` row, which locks its promote and PR target.
  scratch?: { createdByUserId: string; targetBranch?: string | null };
};

export type SeededWorkbenchRun = {
  projectId: string;
  taskId: string | null;
  runId: string;
  workspaceId: string;
  taskKey: string;
};

// One project + (optional) task + run + workspace, shaped as the production
// writers leave them. The project's repo path IS the parent clone.
export async function seedWorkbenchRun(
  db: Db,
  seed: WorkbenchRunSeed,
): Promise<SeededWorkbenchRun> {
  const projectId = randomUUID();
  const runId = randomUUID();
  const workspaceId = randomUUID();
  const taskKey =
    seed.taskKey ??
    `W${projectId
      .replace(/[^0-9A-Za-z]/g, "")
      .slice(0, 6)
      .toUpperCase()}`;

  await db.insert(schema.projects).values({
    id: projectId,
    slug: `wg-${projectId.slice(0, 8)}`,
    name: `wg-${projectId.slice(0, 8)}`,
    repoPath: seed.parentRepoPath,
    mainBranch: "main",
    maisterYamlPath: `${seed.parentRepoPath}/maister.yaml`,
    taskKey,
    ...(seed.publicBranchTemplate
      ? { publicBranchTemplate: seed.publicBranchTemplate }
      : {}),
  });

  let taskId: string | null = null;
  const task = seed.task === undefined ? { number: 1, title: "t" } : seed.task;

  if (task !== null) {
    taskId = randomUUID();
    await db.insert(schema.tasks).values({
      id: taskId,
      projectId,
      number: task.number,
      title: task.title,
      prompt: "p",
      status: "InFlight",
    });
  }

  await db.insert(schema.runs).values({
    id: runId,
    projectId,
    taskId,
    flowVersion: "v1.0.0",
    status: seed.status ?? "Failed",
    runKind: seed.runKind ?? "flow",
    workspaceMode: seed.sharedTreeAllocator
      ? "shared"
      : (seed.workspaceMode ?? null),
    ...(seed.sharedTreeAllocator
      ? { agentWorkspace: "worktree", rootRunId: runId }
      : {}),
    parentRunId: seed.parentRunId ?? null,
    startedAt: new Date(),
    endedAt: new Date(),
  });

  if (seed.runKind === "scratch") {
    if (!seed.scratch || !seed.baseCommit) {
      throw new Error(
        "seedWorkbenchRun: a scratch run needs seed.scratch and seed.baseCommit for its scratch_runs row",
      );
    }
    await db.insert(schema.scratchRuns).values({
      runId,
      projectId,
      initialPrompt: "p",
      baseBranch: seed.baseBranch ?? "main",
      baseCommit: seed.baseCommit,
      targetBranch: seed.scratch.targetBranch ?? null,
      dialogStatus: "Review",
      createdByUserId: seed.scratch.createdByUserId,
    });
  }

  const published = seed.published ?? null;

  await db.insert(schema.workspaces).values({
    id: workspaceId,
    runId,
    projectId,
    branch: seed.branch,
    worktreePath: seed.worktreePath,
    parentRepoPath: seed.parentRepoPath,
    baseBranch: seed.baseBranch === undefined ? "main" : seed.baseBranch,
    baseCommit: seed.baseCommit ?? null,
    targetBranch: seed.targetBranch === undefined ? "main" : seed.targetBranch,
    prUrl: seed.prUrl ?? null,
    prNumber: seed.prNumber ?? null,
    prState: seed.prState ?? null,
    promotionState: seed.promotionState ?? "none",
    removedAt: seed.removedAt ?? null,
    removalKind: seed.removedAt ? "drop" : null,
    archivedBranch: seed.archivedBranch ?? null,
    archivedAt: seed.archivedBranch ? new Date() : null,
    ...(published
      ? {
          publishedBranch: published.branch,
          publishedRemote: published.remote,
          publishedAt: published.at ?? new Date(),
        }
      : {}),
  });

  return { projectId, taskId, runId, workspaceId, taskKey };
}

export async function workspaceRow(
  db: Db,
  workspaceId: string,
): Promise<Record<string, any>> {
  const { eq } = await import("drizzle-orm");
  const rows = await db
    .select()
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, workspaceId));

  return rows[0];
}

export async function runRow(
  db: Db,
  runId: string,
): Promise<Record<string, any>> {
  const { eq } = await import("drizzle-orm");
  const rows = await db
    .select()
    .from(schema.runs)
    .where(eq(schema.runs.id, runId));

  return rows[0];
}

// Every table these suites write, children first.
export const WORKBENCH_GIT_TABLES = [
  "run_sync_attempts",
  "execution_commands",
  "execution_assignments",
  "node_attempts",
  "workspaces",
  "runs",
  "tasks",
  "project_members",
  "projects",
] as const;

export async function clearWorkbenchGitTables(pool: {
  query: (q: string) => Promise<unknown>;
}): Promise<void> {
  for (const table of WORKBENCH_GIT_TABLES) {
    await pool.query(`DELETE FROM "${table}"`);
  }
}
