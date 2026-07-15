import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { eq } from "drizzle-orm";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import * as fullSchema from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { testPlatformRunnerRow } from "@/lib/__tests__/runner-fixtures";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const execFileAsync = promisify(execFile);

// Wrap the network ls-remote helper in a spy (default = real) so the lease-fail
// test can force a stale `remoteShaBefore` capture (simulating "the branch moved
// remotely after we snapshotted its head"); every other test uses the real impl.
vi.mock("@/lib/worktree", async (orig) => {
  const actual = await orig<typeof import("@/lib/worktree")>();

  return { ...actual, remoteBranchHead: vi.fn(actual.remoteBranchHead) };
});

let db: NodePgDatabase;

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

const {
  addWorktree,
  aheadBehindCounts,
  remoteBranchHead,
  syncOperationInProgress,
} = await import("@/lib/worktree");
const { syncRunTarget, assertSyncEligible, verifySyncGate, pushWithLease } =
  await import("@/lib/runs/sync-target");
const { promoteRun } = await import("@/lib/runs/promote");
const { claimLifecycleOperation } = await import(
  "@/lib/workbench-lifecycle/service"
);

const schema = fullSchema as unknown as Record<string, any>;
const { runs, workspaces, tasks, runSyncAttempts } = schema;

let testDatabase: StartedPostgresTestDb;
let pool: Pool;
let root: string;

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "maister_test",
  });
  pool = testDatabase.pool;
  db = testDatabase.db;
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

beforeEach(async () => {
  for (const t of [
    "run_sync_attempts",
    "workspaces",
    "runs",
    "tasks",
    "flows",
    "platform_acp_runners",
    "projects",
    "users",
  ]) {
    await pool.query(`DELETE FROM "${t}"`);
  }
  root = await mkdtemp(join(tmpdir(), `sync-target-${randomUUID()}-`));
  vi.mocked(remoteBranchHead).mockClear();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

// ---- git helpers ----------------------------------------------------------

async function git(
  cwd: string,
  args: readonly string[],
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("git", args, { cwd });
}

async function identity(repo: string): Promise<void> {
  await git(repo, ["config", "user.email", "test@example.test"]);
  await git(repo, ["config", "user.name", "Test User"]);
}

async function headSha(cwd: string, rev = "HEAD"): Promise<string> {
  return (await git(cwd, ["rev-parse", rev])).stdout.trim();
}

// A bare remote + a working parent clone with `base` committed on main and
// pushed to origin.
async function initRepoWithRemote(): Promise<{
  remote: string;
  parent: string;
  baseSha: string;
}> {
  const remote = join(root, `remote-${randomUUID()}.git`);
  const parent = join(root, `parent-${randomUUID()}`);

  await git(root, ["init", "--bare", "-b", "main", remote]);
  await git(root, ["clone", remote, parent]);
  await identity(parent);
  await writeFile(join(parent, "base.txt"), "base\n");
  await git(parent, ["add", "base.txt"]);
  await git(parent, ["commit", "-m", "base"]);
  await git(parent, ["push", "-u", "origin", "main"]);

  return { remote, parent, baseSha: await headSha(parent) };
}

// Add a run worktree on `branch` forked from main; optionally commit a feature.
async function addRunWorktree(
  parent: string,
  branch: string,
  opts?: { feature?: boolean },
): Promise<string> {
  const wt = join(root, `wt-${randomUUID()}`);

  await addWorktree({
    projectRepoPath: parent,
    branch,
    worktreePath: wt,
    startPoint: "main",
  });

  if (opts?.feature !== false) {
    await writeFile(join(wt, "feature.txt"), "feature\n");
    await git(wt, ["add", "feature.txt"]);
    await git(wt, ["commit", "-m", "feature commit"]);
  }

  return wt;
}

// Advance origin/main by one commit WITHOUT touching `parent` (via a throwaway
// clone), so a subsequent fetch in `parent` sees origin ahead.
async function advanceOriginMain(
  remote: string,
  file = "adv.txt",
  content = "adv\n",
): Promise<void> {
  const c = join(root, `adv-${randomUUID()}`);

  await git(root, ["clone", remote, c]);
  await identity(c);
  await writeFile(join(c, file), content);
  await git(c, ["add", file]);
  await git(c, ["commit", "-m", `advance ${file}`]);
  await git(c, ["push", "origin", "main"]);
  await rm(c, { recursive: true, force: true });
}

// ---- seed helpers ---------------------------------------------------------

async function seedGraph(parentRepoPath: string): Promise<{
  projectId: string;
  flowId: string;
  runnerId: string;
}> {
  const projectId = randomUUID();
  const runnerId = randomUUID();
  const flowId = randomUUID();

  await db.insert(schema.projects).values({
    id: projectId,
    slug: `p-${projectId.slice(0, 8)}`,
    name: "P",
    repoPath: parentRepoPath,
    mainBranch: "main",
    maisterYamlPath: "/tmp/m.yaml",
    taskKey: `T${projectId
      .replace(/[^0-9A-Za-z]/g, "")
      .slice(0, 7)
      .toUpperCase()}`,
  });
  await db
    .insert(schema.platformAcpRunners)
    .values(testPlatformRunnerRow(runnerId, "claude"));
  await db.insert(schema.flows).values({
    id: flowId,
    projectId,
    flowRefId: "g",
    source: "github.com/x/y",
    version: "v1.0.0",
    installedPath: "/tmp/flows/g",
    manifest: {},
    schemaVersion: 1,
  });

  return { projectId, flowId, runnerId };
}

type SeedRunOpts = {
  projectId: string;
  flowId: string;
  worktreePath: string;
  branch: string;
  parentRepoPath: string;
  baseCommit: string;
  targetBranch?: string;
  status?: string;
  runKind?: "flow" | "agent" | "scratch";
  workspaceMode?: "own" | "shared" | null;
  parentRunId?: string | null;
  reviewEnteredAt?: Date | null;
  prUrl?: string | null;
  promotionState?: string;
  lifecycleOperationState?: string;
  lifecycleOperationName?: string | null;
};

async function seedRun(opts: SeedRunOpts): Promise<{
  runId: string;
  workspaceId: string;
}> {
  const runId = randomUUID();
  const taskId = randomUUID();
  const workspaceId = randomUUID();

  await db.insert(tasks).values({
    id: taskId,
    projectId: opts.projectId,
    number: Math.trunc(Math.random() * 1e9) + 1,
    title: "t",
    prompt: "p",
    status: "InFlight",
  });
  await db.insert(runs).values({
    id: runId,
    projectId: opts.projectId,
    taskId,
    flowId: opts.flowId,
    flowVersion: "v1.0.0",
    status: opts.status ?? "Review",
    runKind: opts.runKind ?? "flow",
    workspaceMode: opts.workspaceMode ?? null,
    parentRunId: opts.parentRunId ?? null,
    reviewEnteredAt: opts.reviewEnteredAt ?? null,
  });
  await db.insert(workspaces).values({
    id: workspaceId,
    runId,
    projectId: opts.projectId,
    branch: opts.branch,
    worktreePath: opts.worktreePath,
    parentRepoPath: opts.parentRepoPath,
    baseBranch: "main",
    baseCommit: opts.baseCommit,
    targetBranch: opts.targetBranch ?? "main",
    prUrl: opts.prUrl ?? null,
    promotionState: opts.promotionState ?? "none",
    lifecycleOperationState: opts.lifecycleOperationState ?? "none",
    lifecycleOperationName: opts.lifecycleOperationName ?? null,
    lifecycleOperationAttemptId:
      opts.lifecycleOperationName != null ? randomUUID() : null,
    lifecycleOperationClaimedAt:
      opts.lifecycleOperationName != null ? new Date() : null,
  });

  return { runId, workspaceId };
}

function actor(): { type: "user"; id: string } {
  return { type: "user", id: "user-1" };
}

async function attemptRows(runId: string): Promise<any[]> {
  return db
    .select()
    .from(runSyncAttempts)
    .where(eq(runSyncAttempts.runId, runId));
}

async function readRun(runId: string): Promise<any> {
  const [row] = await db.select().from(runs).where(eq(runs.id, runId));

  return row;
}

// ---------------------------------------------------------------------------

describe("assertSyncEligible", () => {
  const ws = { removedAt: null } as any;
  const base = {
    status: "Review",
    runKind: "flow",
    parentRunId: null,
    workspaceMode: null,
    isExperimentMember: false,
  };

  it("passes an eligible top-level Review flow run", () => {
    expect(() => assertSyncEligible({ ...base }, ws)).not.toThrow();
    expect(() =>
      assertSyncEligible({ ...base, runKind: "agent" }, ws),
    ).not.toThrow();
  });

  it("refuses non-Review, scratch, orchestrator-child, shared, and experiment members", () => {
    for (const bad of [
      { ...base, status: "Running" },
      { ...base, runKind: "scratch" },
      { ...base, parentRunId: "parent-1" },
      { ...base, workspaceMode: "shared" },
      { ...base, isExperimentMember: true },
    ]) {
      expect(() => assertSyncEligible(bad, ws)).toThrow(MaisterError);
      try {
        assertSyncEligible(bad, ws);
      } catch (err) {
        expect((err as MaisterError).code).toBe("PRECONDITION");
      }
    }
  });
});

describe("syncRunTarget — mechanical outcomes", () => {
  it("(a) clean rebase behind>0 → synced, base moved, drift cleared", async () => {
    const { remote, parent, baseSha } = await initRepoWithRemote();
    const wt = await addRunWorktree(parent, "sync/a");

    await advanceOriginMain(remote);
    const { projectId, flowId } = await seedGraph(parent);
    const { runId } = await seedRun({
      projectId,
      flowId,
      worktreePath: wt,
      branch: "sync/a",
      parentRepoPath: parent,
      baseCommit: baseSha,
    });

    const out = await syncRunTarget({ runId, actor: actor(), db });

    expect(out.outcome).toBe("synced");
    expect(out.behind).toBe(1);
    expect(out.pushed).toBe(false);
    // drift cleared: the run branch now contains the advanced target.
    expect((await aheadBehindCounts(parent, "main", "sync/a")).behind).toBe(0);

    const [row] = await attemptRows(runId);

    expect(row.phase).toBe("succeeded");
    expect(row.strategy).toBe("rebase");
    expect(row.mode).toBe("mechanical");
    expect(await readRun(runId)).toMatchObject({ status: "Review" });
  });

  it("(b) behind===0 → noop, no push, HEAD unchanged", async () => {
    const { parent, baseSha } = await initRepoWithRemote();
    const wt = await addRunWorktree(parent, "sync/b");
    const before = await headSha(wt);
    const { projectId, flowId } = await seedGraph(parent);
    const { runId } = await seedRun({
      projectId,
      flowId,
      worktreePath: wt,
      branch: "sync/b",
      parentRepoPath: parent,
      baseCommit: baseSha,
    });

    const out = await syncRunTarget({ runId, actor: actor(), db });

    expect(out).toMatchObject({ outcome: "noop", behind: 0, pushed: false });
    expect(await headSha(wt)).toBe(before);
    expect((await attemptRows(runId))[0].phase).toBe("succeeded");
  });

  it("(c) divergent local target → PRECONDITION naming both SHAs", async () => {
    const { remote, parent, baseSha } = await initRepoWithRemote();

    // Local main diverges (local-only commit X); origin/main advances to Y.
    await writeFile(join(parent, "local.txt"), "X\n");
    await git(parent, ["add", "local.txt"]);
    await git(parent, ["commit", "-m", "local-only X"]);
    const localX = await headSha(parent, "main");

    await advanceOriginMain(remote, "y.txt", "Y\n");

    const wt = await addRunWorktree(parent, "sync/c");
    const { projectId, flowId } = await seedGraph(parent);
    const { runId } = await seedRun({
      projectId,
      flowId,
      worktreePath: wt,
      branch: "sync/c",
      parentRepoPath: parent,
      baseCommit: baseSha,
    });

    await expect(
      syncRunTarget({ runId, actor: actor(), db }),
    ).rejects.toMatchObject({ code: "PRECONDITION" });

    const [row] = await attemptRows(runId);

    expect(row.phase).toBe("aborted");
    expect(localX).toMatch(/^[0-9a-f]{7,}$/);
  });

  it("(d) dirty worktree → PRECONDITION, no attempt row", async () => {
    const { parent, baseSha } = await initRepoWithRemote();
    const wt = await addRunWorktree(parent, "sync/d");

    await writeFile(join(wt, "dirty.txt"), "uncommitted\n");
    const { projectId, flowId } = await seedGraph(parent);
    const { runId } = await seedRun({
      projectId,
      flowId,
      worktreePath: wt,
      branch: "sync/d",
      parentRepoPath: parent,
      baseCommit: baseSha,
    });

    await expect(
      syncRunTarget({ runId, actor: actor(), db }),
    ).rejects.toMatchObject({ code: "PRECONDITION" });
    expect(await attemptRows(runId)).toHaveLength(0);
  });

  it("(i) review_entered_at resets only when HEAD moved", async () => {
    const old = new Date("2020-01-01T00:00:00.000Z");
    const { remote, parent, baseSha } = await initRepoWithRemote();

    // content-moving sync → reset
    const wtA = await addRunWorktree(parent, "sync/i-move");

    await advanceOriginMain(remote);
    const g = await seedGraph(parent);
    const moved = await seedRun({
      projectId: g.projectId,
      flowId: g.flowId,
      worktreePath: wtA,
      branch: "sync/i-move",
      parentRepoPath: parent,
      baseCommit: baseSha,
      reviewEnteredAt: old,
    });

    await syncRunTarget({ runId: moved.runId, actor: actor(), db });

    expect(
      (await readRun(moved.runId)).reviewEnteredAt.getTime(),
    ).toBeGreaterThan(old.getTime());

    // noop sync → unchanged
    const wtB = await addRunWorktree(parent, "sync/i-noop");
    const noop = await seedRun({
      projectId: g.projectId,
      flowId: g.flowId,
      worktreePath: wtB,
      branch: "sync/i-noop",
      parentRepoPath: parent,
      baseCommit: baseSha,
      reviewEnteredAt: old,
    });

    await syncRunTarget({ runId: noop.runId, actor: actor(), db });

    expect((await readRun(noop.runId)).reviewEnteredAt.getTime()).toBe(
      old.getTime(),
    );
  });
});

describe("syncRunTarget — conflict handling", () => {
  async function seedConflict(branch: string): Promise<{
    runId: string;
    wt: string;
    before: string;
  }> {
    const { remote, parent, baseSha } = await initRepoWithRemote();
    const wt = await addRunWorktree(parent, branch, { feature: false });

    // run branch edits file.txt one way…
    await writeFile(join(wt, "conf.txt"), "run side\n");
    await git(wt, ["add", "conf.txt"]);
    await git(wt, ["commit", "-m", "run edits conf"]);
    const before = await headSha(wt);

    // …origin/main edits the same file the other way.
    const c = join(root, `conf-${randomUUID()}`);

    await git(root, ["clone", remote, c]);
    await identity(c);
    await writeFile(join(c, "conf.txt"), "main side\n");
    await git(c, ["add", "conf.txt"]);
    await git(c, ["commit", "-m", "main edits conf"]);
    await git(c, ["push", "origin", "main"]);
    await rm(c, { recursive: true, force: true });

    const { projectId, flowId } = await seedGraph(parent);
    const { runId } = await seedRun({
      projectId,
      flowId,
      worktreePath: wt,
      branch,
      parentRepoPath: parent,
      baseCommit: baseSha,
    });

    return { runId, wt, before };
  }

  it("(h) agent=false conflict → outcome conflict, clean abort, HEAD restored", async () => {
    const { runId, wt, before } = await seedConflict("sync/h");

    const out = await syncRunTarget({
      runId,
      actor: actor(),
      agent: false,
      db,
    });

    expect(out).toMatchObject({ outcome: "conflict", pushed: false });
    expect(out.behind).toBeGreaterThan(0);
    expect(await headSha(wt)).toBe(before);
    expect(await syncOperationInProgress(wt)).toBe(false);
    expect((await attemptRows(runId))[0].phase).toBe("aborted");
  });

  it("agent=true is the Task 10 seam — for now behaves like agent=false", async () => {
    const { runId, wt, before } = await seedConflict("sync/seam");

    const out = await syncRunTarget({ runId, actor: actor(), agent: true, db });

    expect(out.outcome).toBe("conflict");
    expect(await headSha(wt)).toBe(before);
  });
});

describe("syncRunTarget — concurrency keystone", () => {
  it("(e) concurrent double-launch → exactly ONE attempt row, loser CONFLICT", async () => {
    const { remote, parent, baseSha } = await initRepoWithRemote();
    const wt = await addRunWorktree(parent, "sync/e");

    await advanceOriginMain(remote);
    const { projectId, flowId } = await seedGraph(parent);
    const { runId } = await seedRun({
      projectId,
      flowId,
      worktreePath: wt,
      branch: "sync/e",
      parentRepoPath: parent,
      baseCommit: baseSha,
    });

    const results = await Promise.allSettled([
      syncRunTarget({ runId, actor: actor(), db }),
      syncRunTarget({ runId, actor: actor(), db }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter(
      (r): r is PromiseRejectedResult => r.status === "rejected",
    );

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0].reason as MaisterError).code).toBe("CONFLICT");
    // Exactly one attempt row exists — the loser never inserted one.
    expect(await attemptRows(runId)).toHaveLength(1);
  });
});

describe("syncRunTarget — the double fence (both directions)", () => {
  it("(f.1) an active sync claim makes promoteRun refuse CONFLICT", async () => {
    const { parent, baseSha } = await initRepoWithRemote();
    const wt = await addRunWorktree(parent, "sync/f1");
    const { projectId, flowId } = await seedGraph(parent);
    const { runId } = await seedRun({
      projectId,
      flowId,
      worktreePath: wt,
      branch: "sync/f1",
      parentRepoPath: parent,
      baseCommit: baseSha,
      runKind: "agent",
      lifecycleOperationState: "claiming",
      lifecycleOperationName: "sync",
    });

    await expect(
      promoteRun(
        runId,
        { mode: "local_merge", targetBranch: "main", autoOnReady: true },
        { sessionUser: { id: "user-1" }, authorize: async () => {} },
        db,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("(f.2) promotion_state='claiming' makes syncRunTarget refuse CONFLICT", async () => {
    const { parent, baseSha } = await initRepoWithRemote();
    const wt = await addRunWorktree(parent, "sync/f2");
    const { projectId, flowId } = await seedGraph(parent);
    const { runId } = await seedRun({
      projectId,
      flowId,
      worktreePath: wt,
      branch: "sync/f2",
      parentRepoPath: parent,
      baseCommit: baseSha,
      promotionState: "claiming",
    });

    await expect(
      syncRunTarget({ runId, actor: actor(), db }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    // No attempt row — refused at the claim fence.
    expect(await attemptRows(runId)).toHaveLength(0);
  });

  it("(f.3) a shared-slot lifecycle op is refused while sync is claimed", async () => {
    const { parent, baseSha } = await initRepoWithRemote();
    const wt = await addRunWorktree(parent, "sync/f3");
    const { projectId, flowId } = await seedGraph(parent);
    const { runId, workspaceId } = await seedRun({
      projectId,
      flowId,
      worktreePath: wt,
      branch: "sync/f3",
      parentRepoPath: parent,
      baseCommit: baseSha,
      lifecycleOperationState: "claiming",
      lifecycleOperationName: "sync",
    });

    await expect(
      claimLifecycleOperation({ runId, workspaceId, operation: "archive" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

describe("pushWithLease + published push", () => {
  it("pushes cleanly with a matching lease, and reports leaseFailed on a stale expectation", async () => {
    const { parent } = await initRepoWithRemote();
    const wt = await addRunWorktree(parent, "sync/lease");

    await git(wt, ["push", "-u", "origin", "sync/lease"]);
    const remoteSha = await remoteBranchHead({
      projectRepoPath: parent,
      remote: "origin",
      branch: "sync/lease",
    });

    // Advance the local branch so there is something to force.
    await writeFile(join(wt, "more.txt"), "more\n");
    await git(wt, ["add", "more.txt"]);
    await git(wt, ["commit", "-m", "more"]);

    // Stale expectation (base) → lease fails, no throw.
    const stale = await pushWithLease(wt, "sync/lease", "0".repeat(40));

    expect(stale).toEqual({ pushed: false, leaseFailed: true });

    // Correct expectation → pushes.
    const ok = await pushWithLease(wt, "sync/lease", remoteSha);

    expect(ok).toEqual({ pushed: true });
  });

  it("(g) published branch clean rebase → pushed:true", async () => {
    const { remote, parent, baseSha } = await initRepoWithRemote();
    const wt = await addRunWorktree(parent, "sync/g");

    await git(wt, ["push", "-u", "origin", "sync/g"]);
    await advanceOriginMain(remote);
    const { projectId, flowId } = await seedGraph(parent);
    const { runId } = await seedRun({
      projectId,
      flowId,
      worktreePath: wt,
      branch: "sync/g",
      parentRepoPath: parent,
      baseCommit: baseSha,
    });

    const out = await syncRunTarget({ runId, actor: actor(), db });

    expect(out).toMatchObject({ outcome: "synced", pushed: true });
    // remote now matches the rebased local head.
    const remoteAfter = await remoteBranchHead({
      projectRepoPath: parent,
      remote: "origin",
      branch: "sync/g",
    });

    expect(remoteAfter).toBe((await headSha(wt)).toLowerCase());
  });

  it("(g) lease failure after fetch → CONFLICT, local rebase kept", async () => {
    const { remote, parent, baseSha } = await initRepoWithRemote();
    const wt = await addRunWorktree(parent, "sync/g-lease");

    await git(wt, ["push", "-u", "origin", "sync/g-lease"]);
    await advanceOriginMain(remote);
    const { projectId, flowId } = await seedGraph(parent);
    const { runId } = await seedRun({
      projectId,
      flowId,
      worktreePath: wt,
      branch: "sync/g-lease",
      parentRepoPath: parent,
      baseCommit: baseSha,
    });

    // Simulate "the branch moved remotely after we captured its head": the
    // captured remoteShaBefore is stale, so the force-with-lease is rejected.
    vi.mocked(remoteBranchHead).mockResolvedValueOnce("0".repeat(40));

    await expect(
      syncRunTarget({ runId, actor: actor(), db }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    // Local rebase result kept (not aborted); the run branch contains the target.
    expect(await syncOperationInProgress(wt)).toBe(false);
    expect(
      (await aheadBehindCounts(parent, "main", "sync/g-lease")).behind,
    ).toBe(0);
    expect((await attemptRows(runId))[0].phase).toBe("failed");
  });
});

describe("verifySyncGate", () => {
  it("passes a clean tree whose HEAD contains the target sha", async () => {
    const { parent } = await initRepoWithRemote();
    const wt = await addRunWorktree(parent, "sync/gate-ok");
    const targetSha = await headSha(parent, "main");

    await expect(verifySyncGate(wt, targetSha)).resolves.toEqual({ ok: true });
  });

  it("fails when the target is not an ancestor of HEAD", async () => {
    const { remote, parent } = await initRepoWithRemote();
    const wt = await addRunWorktree(parent, "sync/gate-bad");

    await advanceOriginMain(remote);
    await git(parent, ["fetch", "origin"]);
    const unrelated = await headSha(parent, "origin/main");
    const res = await verifySyncGate(wt, unrelated);

    expect(res.ok).toBe(false);
  });

  it("fails on a dirty tree", async () => {
    const { parent } = await initRepoWithRemote();
    const wt = await addRunWorktree(parent, "sync/gate-dirty");
    const targetSha = await headSha(wt);

    await writeFile(join(wt, "dirty.txt"), "x\n");
    const res = await verifySyncGate(wt, targetSha);

    expect(res.ok).toBe(false);
  });
});

describe("POST /api/runs/[runId]/sync route", () => {
  async function invokePost(runId: string, body: unknown): Promise<Response> {
    vi.doMock("@/lib/authz", () => ({
      requireActiveSession: vi.fn(async () => ({
        id: "user-1",
        role: "member",
      })),
      requireProjectAction: vi.fn(async () => undefined),
    }));
    const { POST } = await import("@/app/api/runs/[runId]/sync/route");
    const { NextRequest } = await import("next/server");
    const req = new NextRequest(
      new Request(`http://localhost/api/runs/${runId}/sync`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );

    return POST(req as any, { params: Promise.resolve({ runId }) });
  }

  it("(j) 200 synced with the response body", async () => {
    const { remote, parent, baseSha } = await initRepoWithRemote();
    const wt = await addRunWorktree(parent, "sync/route");

    await advanceOriginMain(remote);
    const { projectId, flowId } = await seedGraph(parent);
    const { runId } = await seedRun({
      projectId,
      flowId,
      worktreePath: wt,
      branch: "sync/route",
      parentRepoPath: parent,
      baseCommit: baseSha,
    });

    const res = await invokePost(runId, {});

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;

    expect(body).toMatchObject({ outcome: "synced", pushed: false });
    expect(typeof body.attemptId).toBe("string");
  });

  it("(j) 422 on an invalid body", async () => {
    const res = await invokePost(randomUUID(), { strategy: "nonsense" });

    expect(res.status).toBe(422);
  });

  it("(j) 422 on an unknown runnerId", async () => {
    const { parent, baseSha } = await initRepoWithRemote();
    const wt = await addRunWorktree(parent, "sync/route-runner");
    const { projectId, flowId } = await seedGraph(parent);
    const { runId } = await seedRun({
      projectId,
      flowId,
      worktreePath: wt,
      branch: "sync/route-runner",
      parentRepoPath: parent,
      baseCommit: baseSha,
    });

    const res = await invokePost(runId, { runnerId: "ghost-runner" });

    expect(res.status).toBe(422);
  });
});
