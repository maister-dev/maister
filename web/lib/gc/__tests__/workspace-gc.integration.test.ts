// M19 Phase 4 (T4.2): runWorkspaceGcSweep against a real Postgres
// testcontainer. The candidate join (workspaces.removed_at IS NULL ⨝
// runs.status IN ('Abandoned','Done') with the EFFECTIVE-deadline gate) and
// the persisted removed_at / archived_branch writes are exercised on a real
// DB; preserveWorktree, removeOwnedWorktree and resolveBaseRef are INJECTED
// via opts so the orchestration (preserve→remove ordering, F1 skip-on-
// preserve-failure, F3 ended_at fallback, idempotent re-run) is asserted via
// the returned summary + DB state. Mirrors reconcile-sweep.integration.test.ts.
//
// Scenarios (QA contract T4.2 / plan T4.6):
//   1. scheduled_removal_at in the FUTURE → NOT collected.
//   2. scheduled_removal_at in the PAST → collected; preserve→remove; removed_at
//      set; archived_branch persisted.
//   3. F3: scheduled_removal_at NULL + ended_at older than gcAgeDays() →
//      collected via the ended_at fallback.
//   4. F1: preserveWorktree returns {ok:false} → removeOwnedWorktree NOT called;
//      removed_at STAYS null; skippedUnpreserved++.
//   5. idempotent re-run on an already-removed row (removed_at set) → no-op.

import { randomUUID } from "node:crypto";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import * as schemaModule from "@/lib/db/schema";
import { runWorkspaceGcSweep } from "@/lib/gc/workspace-gc";
import { gcAgeDays } from "@/lib/instance-config";

const schema = schemaModule as unknown as Record<string, any>;
const { executors, flowRevisions, flows, projects, runs, tasks, users, workspaces } =
  schema;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;
let projectId: string;
let projectRepoPath: string;
let executorId: string;
let flowId: string;
let flowRevisionId: string;
let userId: string;

const MANIFEST = { schemaVersion: 1, name: "gc", steps: [] };

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("workspace_gc_test")
    .withUsername("test")
    .withPassword("test")
    .start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);
  await migrate(db, { migrationsFolder: "./lib/db/migrations" });

  projectId = randomUUID();
  projectRepoPath = `/repos/wsgc-${randomUUID()}`;
  executorId = randomUUID();
  flowId = randomUUID();
  flowRevisionId = randomUUID();
  userId = randomUUID();

  await db.insert(users).values({
    id: userId,
    email: `wsgc-${userId}@maister.local`,
    role: "member",
    accountStatus: "active",
  });

  await db.insert(projects).values({
    id: projectId,
    slug: "wsgc-app",
    name: "WS GC App",
    repoPath: projectRepoPath,
    mainBranch: "main",
    maisterYamlPath: `${projectRepoPath}/maister.yaml`,
  });

  await db.insert(executors).values({
    id: executorId,
    projectId,
    executorRefId: "claude-sonnet",
    agent: "claude",
    model: "claude-sonnet-4-6",
  });

  await db.insert(flows).values({
    id: flowId,
    projectId,
    flowRefId: "gc",
    source: "github.com/x/gc",
    version: "v1.0.0",
    installedPath: "/tmp/flows/gc",
    manifest: MANIFEST,
    schemaVersion: 1,
  });

  await db.insert(flowRevisions).values({
    id: flowRevisionId,
    flowRefId: "gc",
    source: "github.com/x/gc",
    versionLabel: "v1.0.0",
    resolvedRevision: "cafef00d",
    manifestDigest: "sha256:gc",
    manifest: MANIFEST,
    schemaVersion: 1,
    installedPath: "/tmp/flows/gc",
    packageStatus: "Installed",
  });
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

beforeEach(async () => {
  await db.delete(workspaces);
  await db.delete(runs);
  await db.delete(tasks);
});

type SeedOpts = {
  runStatus?: string;
  endedAt?: Date | null;
  scheduledRemovalAt?: Date | null;
  removedAt?: Date | null;
  worktreePath?: string;
};

// Seed a terminal run + its workspace. Returns { runId, workspaceId }.
async function seed(opts: SeedOpts = {}): Promise<{
  runId: string;
  workspaceId: string;
  worktreePath: string;
}> {
  const taskId = randomUUID();
  const runId = randomUUID();
  const workspaceId = randomUUID();
  const worktreePath = opts.worktreePath ?? `/worktrees/wsgc-${runId}`;

  await db.insert(tasks).values({
    id: taskId,
    projectId,
    title: "t",
    prompt: "p",
    flowId,
    status: "Abandoned",
  });

  await db.insert(runs).values({
    id: runId,
    taskId,
    projectId,
    flowId,
    flowRevisionId,
    executorId,
    status: opts.runStatus ?? "Abandoned",
    flowVersion: "v1",
    startedAt: new Date(Date.now() - 30 * 86_400_000),
    endedAt: opts.endedAt === undefined ? new Date() : opts.endedAt,
  });

  await db.insert(workspaces).values({
    id: workspaceId,
    runId,
    projectId,
    branch: `maister/${runId}`,
    worktreePath,
    parentRepoPath: projectRepoPath,
    removedAt: opts.removedAt ?? null,
    scheduledRemovalAt:
      opts.scheduledRemovalAt === undefined ? null : opts.scheduledRemovalAt,
  });

  return { runId, workspaceId, worktreePath };
}

async function readWorkspace(workspaceId: string): Promise<any> {
  const rows = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId));

  return rows[0];
}

// Inject a successful preserve (returns an archive branch) + spies for
// removeOwnedWorktree + resolveBaseRef so we assert orchestration only.
function makeOpts(
  over: {
    preserveResult?: (args: { runId: string }) => Promise<unknown>;
    now?: () => Date;
    // Synthetic worktree paths in these fixtures never exist on disk; default
    // the §3.3 recovery probe to "present" so the preserve→remove flow runs.
    // Pass `false` (or omit to use the real probe) to exercise the recovery.
    worktreeExists?: (worktreePath: string) => Promise<boolean>;
  } = {},
) {
  const removeOwnedWorktree = vi.fn(
    async (_args: Record<string, unknown>) => {},
  );
  const resolveBaseRef = vi.fn(async () => "basesha0000000000000000000000000000000000");
  const preserveWorktree = vi.fn(
    over.preserveResult ??
      (async (args: { runId: string }) => ({
        ok: true,
        archivedBranch: `maister/archive/${args.runId}`,
        archivedAt: new Date(),
        snapshotted: true,
      })),
  );
  const worktreeExists = vi.fn(over.worktreeExists ?? (async () => true));

  return {
    opts: {
      db,
      now: over.now ?? (() => new Date()),
      preserveWorktree,
      removeOwnedWorktree,
      resolveBaseRef,
      worktreeExists,
    },
    preserveWorktree,
    removeOwnedWorktree,
    resolveBaseRef,
    worktreeExists,
  };
}

describe("runWorkspaceGcSweep (integration)", () => {
  it("does NOT collect a workspace whose scheduled_removal_at is in the future", async () => {
    const { workspaceId } = await seed({
      scheduledRemovalAt: new Date(Date.now() + 7 * 86_400_000),
    });

    const { opts, preserveWorktree, removeOwnedWorktree } = makeOpts();
    const summary = await runWorkspaceGcSweep(opts);

    expect(summary.scanned).toBe(0);
    expect(summary.pruned).toBe(0);
    expect(preserveWorktree).not.toHaveBeenCalled();
    expect(removeOwnedWorktree).not.toHaveBeenCalled();
    expect((await readWorkspace(workspaceId)).removedAt).toBeNull();
  }, 60_000);

  it("collects a past-deadline workspace: preserve → remove → removed_at + archived_branch persisted", async () => {
    const { runId, workspaceId, worktreePath } = await seed({
      scheduledRemovalAt: new Date(Date.now() - 86_400_000),
    });

    const { opts, preserveWorktree, removeOwnedWorktree } = makeOpts();
    const summary = await runWorkspaceGcSweep(opts);

    expect(summary.scanned).toBeGreaterThanOrEqual(1);
    expect(summary.preserved).toBeGreaterThanOrEqual(1);
    expect(summary.pruned).toBeGreaterThanOrEqual(1);

    // preserve was called BEFORE remove (preserve-then-prune ordering).
    expect(preserveWorktree).toHaveBeenCalledTimes(1);
    expect(removeOwnedWorktree).toHaveBeenCalledTimes(1);
    expect(preserveWorktree.mock.invocationCallOrder[0]).toBeLessThan(
      removeOwnedWorktree.mock.invocationCallOrder[0],
    );

    // removeOwnedWorktree was called with the workspace's path + force + an
    // allowedRoot (worktreesRoot()).
    const removeArg = removeOwnedWorktree.mock.calls[0][0] as Record<
      string,
      unknown
    >;

    expect(removeArg.worktreePath).toBe(worktreePath);
    expect(removeArg.force).toBe(true);
    expect(typeof removeArg.allowedRoot).toBe("string");

    const ws = await readWorkspace(workspaceId);

    expect(ws.removedAt).not.toBeNull();
    expect(ws.archivedBranch).toBe(`maister/archive/${runId}`);
    expect(ws.archivedAt).not.toBeNull();
  }, 60_000);

  it("F3: a null scheduled_removal_at + ended_at older than gcAgeDays() is collected via the ended_at fallback", async () => {
    const ageMs = gcAgeDays() * 86_400_000;
    const { workspaceId } = await seed({
      scheduledRemovalAt: null,
      endedAt: new Date(Date.now() - ageMs - 86_400_000),
    });

    const { opts, removeOwnedWorktree } = makeOpts();
    const summary = await runWorkspaceGcSweep(opts);

    expect(summary.scanned).toBeGreaterThanOrEqual(1);
    expect(summary.pruned).toBeGreaterThanOrEqual(1);
    expect(removeOwnedWorktree).toHaveBeenCalledTimes(1);
    expect((await readWorkspace(workspaceId)).removedAt).not.toBeNull();
  }, 60_000);

  it("F3: a null scheduled_removal_at whose ended_at is NEWER than gcAgeDays() is NOT collected", async () => {
    const { workspaceId } = await seed({
      scheduledRemovalAt: null,
      endedAt: new Date(),
    });

    const { opts, removeOwnedWorktree } = makeOpts();
    const summary = await runWorkspaceGcSweep(opts);

    expect(summary.scanned).toBe(0);
    expect(removeOwnedWorktree).not.toHaveBeenCalled();
    expect((await readWorkspace(workspaceId)).removedAt).toBeNull();
  }, 60_000);

  it("F1: preserve returns {ok:false} → removeOwnedWorktree NOT called, removed_at stays null, skippedUnpreserved++", async () => {
    const { workspaceId } = await seed({
      scheduledRemovalAt: new Date(Date.now() - 86_400_000),
    });

    const { opts, removeOwnedWorktree } = makeOpts({
      preserveResult: async () => ({ ok: false }),
    });
    const summary = await runWorkspaceGcSweep(opts);

    expect(summary.scanned).toBeGreaterThanOrEqual(1);
    expect(summary.skippedUnpreserved).toBeGreaterThanOrEqual(1);
    expect(summary.pruned).toBe(0);
    expect(removeOwnedWorktree).not.toHaveBeenCalled();
    expect((await readWorkspace(workspaceId)).removedAt).toBeNull();
  }, 60_000);

  it("is idempotent: re-running over an already-removed workspace is a no-op", async () => {
    const { workspaceId } = await seed({
      scheduledRemovalAt: new Date(Date.now() - 86_400_000),
      removedAt: new Date(),
    });

    const { opts, preserveWorktree, removeOwnedWorktree } = makeOpts();
    const summary = await runWorkspaceGcSweep(opts);

    expect(summary.scanned).toBe(0);
    expect(summary.pruned).toBe(0);
    expect(preserveWorktree).not.toHaveBeenCalled();
    expect(removeOwnedWorktree).not.toHaveBeenCalled();
    expect((await readWorkspace(workspaceId)).removedAt).not.toBeNull();
  }, 60_000);

  it("does NOT collect a non-terminal (Running) run's workspace even past its deadline", async () => {
    const { workspaceId } = await seed({
      runStatus: "Running",
      endedAt: null,
      scheduledRemovalAt: new Date(Date.now() - 86_400_000),
    });

    const { opts, removeOwnedWorktree } = makeOpts();
    const summary = await runWorkspaceGcSweep(opts);

    expect(summary.scanned).toBe(0);
    expect(removeOwnedWorktree).not.toHaveBeenCalled();
    expect((await readWorkspace(workspaceId)).removedAt).toBeNull();
  }, 60_000);

  it("§3.3 pruned-not-marked recovery: a due workspace whose worktree path is already gone is marked removed_at without preserve/remove", async () => {
    const { workspaceId } = await seed({
      scheduledRemovalAt: new Date(Date.now() - 86_400_000),
      worktreePath: `/worktrees/wsgc-missing-${randomUUID()}`,
    });

    // The worktree path is already gone (prior tick pruned it then died before
    // the DB write). The recovery branch must converge removed_at WITHOUT
    // calling preserve (which would throw/ok:false on the missing path) or
    // removeOwnedWorktree (which would no-op/error). A preserve that throws
    // proves it is never reached.
    const { opts, preserveWorktree, removeOwnedWorktree } = makeOpts({
      worktreeExists: async () => false,
      preserveResult: async () => {
        throw new Error("preserve must not be called on an already-gone worktree");
      },
    });
    const summary = await runWorkspaceGcSweep(opts);

    expect(summary.pruned).toBeGreaterThanOrEqual(1);
    expect(summary.skippedUnpreserved).toBe(0);
    expect(summary.failed).toBe(0);
    expect(preserveWorktree).not.toHaveBeenCalled();
    expect(removeOwnedWorktree).not.toHaveBeenCalled();
    expect((await readWorkspace(workspaceId)).removedAt).not.toBeNull();
  }, 60_000);
});
