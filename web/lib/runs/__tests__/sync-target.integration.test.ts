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

// Two git helpers are wrapped as spies (default = real, so every other test runs
// the real impl). Both double as deterministic seams for injecting a concurrent
// abandon at an EXACT point in the sync — the only way to test the abandon↔sync
// race without racing real threads and hoping for the interleave:
//   - `remoteBranchHead` is the network ls-remote read at sync-target.ts:633,
//     inside the window between the unlocked eligibility read and the claim tx.
//     (It also lets the lease-fail test force a stale `remoteShaBefore` capture.)
//   - `aheadBehindCounts` FIRST runs at sync-target.ts:760 — after the claim
//     commits, before the rebase. Its other call site (:240, inside
//     `verifySyncGate`) runs later, so a `...Once` impl always lands on :760.
vi.mock("@/lib/worktree", async (orig) => {
  const actual = await orig<typeof import("@/lib/worktree")>();

  return {
    ...actual,
    remoteBranchHead: vi.fn(actual.remoteBranchHead),
    aheadBehindCounts: vi.fn(actual.aheadBehindCounts),
  };
});

let db: NodePgDatabase;

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

const {
  addWorktree,
  aheadBehindCounts,
  remoteBranchHead,
  syncOperationInProgress,
} = await import("@/lib/worktree");
// The UNMOCKED module. An injected spy runs its side effect and then defers to the
// real helper through this, so the abandon tests never fake git state.
const actualWorktree =
  await vi.importActual<typeof import("@/lib/worktree")>("@/lib/worktree");
const {
  syncRunTarget,
  assertSyncEligible,
  verifySyncGate,
  pushWithLease,
  acquireSyncDriver,
} = await import("@/lib/runs/sync-target");
const { promoteRun } = await import("@/lib/runs/promote");
const { markAbandoned } = await import("@/lib/runs/state-transitions");
const { claimLifecycleOperation } = await import(
  "@/lib/workbench-lifecycle/service"
);

type LifecycleOperationName =
  import("@/lib/workbench-lifecycle/service").LifecycleOperationName;

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
  vi.mocked(aheadBehindCounts).mockClear();
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
  lifecycleOperationClaimedAt?: Date;
  lifecycleOperationAttemptId?: string;
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
      opts.lifecycleOperationAttemptId ??
      (opts.lifecycleOperationName != null ? randomUUID() : null),
    lifecycleOperationClaimedAt:
      opts.lifecycleOperationClaimedAt ??
      (opts.lifecycleOperationName != null ? new Date() : null),
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

    const originY = await remoteBranchHead({
      projectRepoPath: parent,
      remote: "origin",
      branch: "main",
    });

    // The test is named "naming both SHAs" and used to assert only that a SHA it
    // had read from git itself looked like hex — nothing inspected the message.
    // Both SHAs are the whole point: the operator has to reconcile the target by
    // hand, and cannot without knowing which two commits diverged.
    await expect(
      syncRunTarget({ runId, actor: actor(), db }),
    ).rejects.toMatchObject({
      code: "PRECONDITION",
      message: expect.stringContaining(localX),
    });
    await expect(
      syncRunTarget({ runId, actor: actor(), db }),
    ).rejects.toMatchObject({
      message: expect.stringContaining(originY as string),
    });

    const [row] = await attemptRows(runId);

    expect(row.phase).toBe("aborted");
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

  it("agent=true with no resolver runner configured → EXECUTOR_UNAVAILABLE, clean abort", async () => {
    // Task 10: agent=true launches the AI resolver, which refuses BEFORE spawning
    // a session when no sync runner resolves (this seed has no default/sync
    // runner). The conflicted rebase is aborted and the attempt marked aborted.
    const { runId, wt, before } = await seedConflict("sync/seam");

    await expect(
      syncRunTarget({ runId, actor: actor(), agent: true, db }),
    ).rejects.toMatchObject({ code: "EXECUTOR_UNAVAILABLE" });

    expect(await headSha(wt)).toBe(before);
    expect(await syncOperationInProgress(wt)).toBe(false);
    expect((await attemptRows(runId))[0].phase).toBe("aborted");
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

  // #C3: the ADR claims "both directions are matrix tested"; the actual coverage was
  // three point tests. `claiming` was tested and `done` was not — yet `done` is the
  // state a COMPLETED promotion leaves behind, so this is the common one.
  it("(f.2b) promotion_state='done' also makes syncRunTarget refuse CONFLICT", async () => {
    const { parent, baseSha } = await initRepoWithRemote();
    const wt = await addRunWorktree(parent, "sync/f2b");
    const { projectId, flowId } = await seedGraph(parent);
    const { runId } = await seedRun({
      projectId,
      flowId,
      worktreePath: wt,
      branch: "sync/f2b",
      parentRepoPath: parent,
      baseCommit: baseSha,
      promotionState: "done",
    });

    await expect(
      syncRunTarget({ runId, actor: actor(), db }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await attemptRows(runId)).toHaveLength(0);
  });

  // The carve-out the whole reopen→sync path depends on. `reopened` is neither
  // `claiming` nor `done`, so it must PASS the fence — if it ever started blocking,
  // every existing test would still be green while the feature's headline flow (a
  // conflicted PR is reopened, then re-synced) was dead.
  it("(f.2c) promotion_state='reopened' PASSES the fence — reopen→sync is the point", async () => {
    const { remote, parent, baseSha } = await initRepoWithRemote();
    const wt = await addRunWorktree(parent, "sync/f2c");

    await advanceOriginMain(remote);
    const { projectId, flowId } = await seedGraph(parent);
    const { runId } = await seedRun({
      projectId,
      flowId,
      worktreePath: wt,
      branch: "sync/f2c",
      parentRepoPath: parent,
      baseCommit: baseSha,
      promotionState: "reopened",
    });

    const out = await syncRunTarget({ runId, actor: actor(), db });

    expect(out.outcome).toBe("synced");
    // It really ran: an attempt row exists and reached a terminal phase.
    const [attempt] = await attemptRows(runId);

    expect(attempt.phase).toBe("succeeded");
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

  // (f.3) proved `archive` only. The slot is shared by SIX operations, and "sync is
  // mutually exclusive with the other five" is the claim — so enumerate them. Table
  // driven off the exported union, so a seventh operation cannot be added without
  // either appearing here or failing the type.
  it.each<LifecycleOperationName>([
    "drop",
    "exportBranch",
    "snapshotCommit",
    "handoffBranch",
  ])("(f.3) a claimed sync also refuses %s", async (operation) => {
    const { parent, baseSha } = await initRepoWithRemote();
    const wt = await addRunWorktree(parent, `sync/f3-${operation}`);
    const { projectId, flowId } = await seedGraph(parent);
    const { runId, workspaceId } = await seedRun({
      projectId,
      flowId,
      worktreePath: wt,
      branch: `sync/f3-${operation}`,
      parentRepoPath: parent,
      baseCommit: baseSha,
      lifecycleOperationState: "claiming",
      lifecycleOperationName: "sync",
    });

    await expect(
      claimLifecycleOperation({ runId, workspaceId, operation }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  // (f.3) above only ever seeds a FRESH `claimed_at`, so it proves the fence for a
  // young claim and never reaches the window where it breaks. The lifecycle claim
  // is a LEASE: `canReclaimLifecycle` steals any `claiming` slot older than
  // `promotionClaimTimeoutSeconds()` (300s), while a sync legitimately runs far
  // longer — `agent_running_since` is re-stamped on every HITL resume, so a
  // resolver waiting on a human holds the slot for hours. A steal overwrites
  // `lifecycle_operation_name='sync'`, the exact predicate promote's reverse fence
  // reads, so promotion then merges a branch mid-rebase.
  describe("(f.4) the claim lease vs a long-running sync", () => {
    const ORIGINAL_TIMEOUT =
      process.env.MAISTER_PROMOTION_CLAIM_TIMEOUT_SECONDS;

    beforeEach(() => {
      // 4s window ⇒ the driver beats every 1s (window / 4).
      process.env.MAISTER_PROMOTION_CLAIM_TIMEOUT_SECONDS = "4";
    });

    afterEach(() => {
      if (ORIGINAL_TIMEOUT === undefined) {
        delete process.env.MAISTER_PROMOTION_CLAIM_TIMEOUT_SECONDS;
      } else {
        process.env.MAISTER_PROMOTION_CLAIM_TIMEOUT_SECONDS = ORIGINAL_TIMEOUT;
      }
    });

    async function seedStaleSyncClaim(name: string) {
      const { parent, baseSha } = await initRepoWithRemote();
      const wt = await addRunWorktree(parent, name);
      const { projectId, flowId } = await seedGraph(parent);
      const lifecycleOperationAttemptId = randomUUID();
      const seeded = await seedRun({
        projectId,
        flowId,
        worktreePath: wt,
        branch: name,
        parentRepoPath: parent,
        baseCommit: baseSha,
        lifecycleOperationState: "claiming",
        lifecycleOperationName: "sync",
        lifecycleOperationAttemptId,
        // Older than the whole window — a sync this old is either dead (and SHOULD
        // be reclaimed) or alive and beating.
        lifecycleOperationClaimedAt: new Date(Date.now() - 60_000),
      });

      return { ...seeded, lifecycleOperationAttemptId };
    }

    async function readClaim(workspaceId: string) {
      const [row] = await db
        .select()
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId));

      return row;
    }

    it("a LIVE driver beats the lease, so the slot stays un-stealable past the window", async () => {
      const { runId, workspaceId, lifecycleOperationAttemptId } =
        await seedStaleSyncClaim("sync/f4a");

      // Precondition: without a beat this claim is stale ⇒ genuinely stealable.
      // That is the self-healing the window is for, and it is what makes the
      // steal below a real risk rather than a hypothetical.
      const before = await readClaim(workspaceId);

      expect(
        Date.now() - new Date(before.lifecycleOperationClaimedAt).getTime(),
      ).toBeGreaterThan(4_000);

      const release = acquireSyncDriver(db, runId, {
        attemptId: randomUUID(),
        attempt: 1,
        workspaceId,
        lifecycleAttemptId: lifecycleOperationAttemptId,
      });

      try {
        await new Promise((r) => setTimeout(r, 1_400));

        const after = await readClaim(workspaceId);

        expect(
          new Date(after.lifecycleOperationClaimedAt).getTime(),
        ).toBeGreaterThan(
          new Date(before.lifecycleOperationClaimedAt).getTime(),
        );
        // The whole point: a workbench op can no longer steal the slot out from
        // under the live sync, so `name='sync'` survives for promote's fence.
        await expect(
          claimLifecycleOperation({ runId, workspaceId, operation: "archive" }),
        ).rejects.toMatchObject({ code: "CONFLICT" });
        expect((await readClaim(workspaceId)).lifecycleOperationName).toBe(
          "sync",
        );
      } finally {
        release();
      }
    });

    it("the beat is FENCED — it never refreshes a slot another op has taken over", async () => {
      const { runId, workspaceId } = await seedStaleSyncClaim("sync/f4b");

      // The driver holds a token that is NOT the one on the row (i.e. the slot
      // was taken over). Its beat must not resurrect someone else's claim.
      const release = acquireSyncDriver(db, runId, {
        attemptId: randomUUID(),
        attempt: 1,
        workspaceId,
        lifecycleAttemptId: randomUUID(),
      });

      try {
        const before = await readClaim(workspaceId);

        await new Promise((r) => setTimeout(r, 1_400));

        const after = await readClaim(workspaceId);

        expect(new Date(after.lifecycleOperationClaimedAt).getTime()).toBe(
          new Date(before.lifecycleOperationClaimedAt).getTime(),
        );
      } finally {
        release();
      }
    });
  });
});

// The abandon↔sync race. `markAbandoned` CASes `runs.status` while the sync claim
// locks `workspaces` — different rows, free to interleave — and abandon is an
// ordinary button with no guard while a sync runs. Both orders below were
// reachable and completely uncovered: a force-push could land on a run the user
// had already abandoned.
describe("syncRunTarget — abandon during sync", () => {
  // ORDER A — abandon commits BEFORE the claim. The eligibility gate read `Review`
  // from an UNLOCKED select, then a git exec and a network ls-remote ran before the
  // claim tx, which never re-read `runs`. So the claim minted an attempt for an
  // already-Abandoned run and the driver rebased and force-pushed it.
  it("(order A) refuses, and mints NO attempt, when the run is abandoned before the claim", async () => {
    const { remote, parent, baseSha } = await initRepoWithRemote();
    const wt = await addRunWorktree(parent, "sync/abandon-a");

    await advanceOriginMain(remote);
    const { projectId, flowId } = await seedGraph(parent);
    const { runId } = await seedRun({
      projectId,
      flowId,
      worktreePath: wt,
      branch: "sync/abandon-a",
      parentRepoPath: parent,
      baseCommit: baseSha,
      // published ⇒ the ls-remote seam runs, and a push would be attempted.
      prUrl: "https://github.com/x/y/pull/1",
    });

    vi.mocked(remoteBranchHead).mockImplementationOnce(async () => {
      await markAbandoned(runId, { db });

      return null;
    });

    await expect(
      syncRunTarget({ runId, actor: actor(), db }),
    ).rejects.toMatchObject({ code: "PRECONDITION" });

    // No attempt row at all — the claim must refuse, not mint-then-fail.
    expect(await attemptRows(runId)).toHaveLength(0);
    expect((await readRun(runId)).reviewEnteredAt).toBeNull();
  });

  // ORDER B — abandon commits AFTER the claim, while the driver runs. `markAbandoned`
  // → `releaseSyncClaimOnTerminal` stamps the attempt `failed` and frees the slot,
  // but every phase write was unconditional by attempt id, so the driver rebased and
  // force-pushed anyway and resurrected the ledger `failed → rebasing → … → succeeded`.
  it("(order B) stops before the rebase and never resurrects the ledger when abandoned after the claim", async () => {
    const { remote, parent, baseSha } = await initRepoWithRemote();
    const wt = await addRunWorktree(parent, "sync/abandon-b");

    await advanceOriginMain(remote);
    const { projectId, flowId } = await seedGraph(parent);
    const { runId } = await seedRun({
      projectId,
      flowId,
      worktreePath: wt,
      branch: "sync/abandon-b",
      parentRepoPath: parent,
      baseCommit: baseSha,
      prUrl: "https://github.com/x/y/pull/2",
    });
    const headBefore = await headSha(wt);
    const originBefore = await headSha(parent, "origin/sync/abandon-b").catch(
      () => null,
    );

    vi.mocked(aheadBehindCounts).mockImplementationOnce(async (...args) => {
      await markAbandoned(runId, { db });

      return actualWorktree.aheadBehindCounts(...args);
    });

    await expect(
      syncRunTarget({ runId, actor: actor(), db }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    // The ledger keeps the terminal `failed` abandon wrote — never `succeeded`.
    const [attempt] = await attemptRows(runId);

    expect(attempt.phase).toBe("failed");
    expect(attempt.pushed).toBe(false);

    // The decisive assertion: the branch was never rebased and never pushed.
    expect(await headSha(wt)).toBe(headBefore);
    expect(
      await headSha(parent, "origin/sync/abandon-b").catch(() => null),
    ).toBe(originBefore);
    expect((await readRun(runId)).status).toBe("Abandoned");
  });

  // `settleAttempt` stamped `runs.review_entered_at` unconditionally, so the no-op
  // path (behind === 0) restarted the auto-promotion grace window on a run that had
  // just been abandoned. Distinct path from order B: it never reaches a rebase.
  it("never stamps review_entered_at on a run abandoned during a no-op sync", async () => {
    const { parent, baseSha } = await initRepoWithRemote();
    const wt = await addRunWorktree(parent, "sync/abandon-noop");

    // No advanceOriginMain ⇒ behind === 0 ⇒ the settle-as-noop path.
    const { projectId, flowId } = await seedGraph(parent);
    const { runId } = await seedRun({
      projectId,
      flowId,
      worktreePath: wt,
      branch: "sync/abandon-noop",
      parentRepoPath: parent,
      baseCommit: baseSha,
    });

    vi.mocked(aheadBehindCounts).mockImplementationOnce(async (...args) => {
      await markAbandoned(runId, { db });

      return actualWorktree.aheadBehindCounts(...args);
    });

    await expect(
      syncRunTarget({ runId, actor: actor(), db }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    expect((await readRun(runId)).reviewEnteredAt).toBeNull();
    expect((await attemptRows(runId))[0].phase).toBe("failed");
  });
});

// A sync that wrote its terminal phase and then died before releasing the claim
// leaves the one shape no recovery arm can see: every sweep filters to NON-terminal
// attempts. Promote and the workbench ops escape it via their staleness carve-outs;
// sync's own forward fence had none, so the strand refused every FUTURE sync on the
// workspace until some unrelated lifecycle op happened to steal the slot.
describe("syncRunTarget — stranded lifecycle claims", () => {
  async function seedClaimed(
    label: string,
    claim: {
      lifecycleOperationName: string;
      lifecycleOperationClaimedAt?: Date;
    },
  ): Promise<{ runId: string; workspaceId: string }> {
    const { parent, baseSha } = await initRepoWithRemote();
    const wt = await addRunWorktree(parent, `sync/${label}`);
    const { projectId, flowId } = await seedGraph(parent);

    return seedRun({
      projectId,
      flowId,
      worktreePath: wt,
      branch: `sync/${label}`,
      parentRepoPath: parent,
      baseCommit: baseSha,
      lifecycleOperationState: "claiming",
      ...claim,
    });
  }

  // CONTROL. The carve-out below must not become "a sync can barge through any
  // claim": a live lifecycle op still wins. Nothing covered this direction — the
  // existing fence tests all prove the reverse (a claimed sync refuses archive/…).
  it("still refuses a sync while a FRESH lifecycle claim is held", async () => {
    const { runId } = await seedClaimed("fence-fresh", {
      lifecycleOperationName: "archive",
    });

    await expect(
      syncRunTarget({ runId, actor: actor(), db }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("lets a new sync steal a claim that has gone stale", async () => {
    // Older than promotionClaimTimeoutSeconds() (300s) — the same threshold
    // `canReclaimLifecycle` and promote's reverse fence already steal on, so the
    // three now agree instead of sync alone holding out forever.
    const { runId, workspaceId } = await seedClaimed("fence-stale", {
      lifecycleOperationName: "sync",
      lifecycleOperationClaimedAt: new Date(Date.now() - 3_600_000),
    });

    // behind === 0 ⇒ noop; reaching an outcome at all is the proof it got past the
    // fence that used to refuse unconditionally.
    const out = await syncRunTarget({ runId, actor: actor(), db });

    expect(out.outcome).toBe("noop");

    const [ws] = await db
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId));

    expect(ws.lifecycleOperationState).toBe("none");
  });

  it("releases a claim held behind an ALREADY-terminal attempt when the run terminalizes", async () => {
    const { runId, workspaceId } = await seedClaimed("strand-terminal", {
      lifecycleOperationName: "sync",
    });

    // The precise crash shape: terminal attempt, claim still held.
    await db.insert(runSyncAttempts).values({
      id: randomUUID(),
      runId,
      workspaceId,
      attempt: 1,
      strategy: "rebase",
      mode: "mechanical",
      phase: "succeeded",
      targetRef: "main",
    });

    await markAbandoned(runId, { db });

    // `releaseSyncClaimOnTerminal` used to return early here — no non-terminal
    // attempt matched, so it concluded there was no claim to free and left it held.
    const [ws] = await db
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId));

    expect(ws.lifecycleOperationState).toBe("none");
    expect(ws.lifecycleOperationName).toBeNull();
    expect(ws.lifecycleOperationAttemptId).toBeNull();
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

  // #C1: `grep -i indeterminate` across every test file returned NOTHING. This is
  // the only guard between the resolver and an UNLEASED force-push: `remoteShaBefore`
  // is captured BEFORE the all-refs fetch precisely so it can be the lease authority,
  // and if that read failed there is no authority to lease against. Pushing anyway
  // would mean `--force` with no `--force-with-lease`, silently overwriting whatever
  // landed on the branch meanwhile.
  it("(#C1) refuses the push when origin's head could not be read, and KEEPS the local rebase", async () => {
    const { remote, parent, baseSha } = await initRepoWithRemote();
    const wt = await addRunWorktree(parent, "sync/indeterminate");

    await git(wt, ["push", "-u", "origin", "sync/indeterminate"]);
    await advanceOriginMain(remote);
    const { projectId, flowId } = await seedGraph(parent);
    const { runId } = await seedRun({
      projectId,
      flowId,
      worktreePath: wt,
      branch: "sync/indeterminate",
      parentRepoPath: parent,
      baseCommit: baseSha,
    });

    // The pre-fetch `ls-remote` capture fails → the lease authority is unknown.
    // Only the FIRST call is stubbed: the assertions below re-read origin for real.
    vi.mocked(remoteBranchHead).mockRejectedValueOnce(
      new Error("network down"),
    );

    await expect(
      syncRunTarget({ runId, actor: actor(), db }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      // The REASON must be the indeterminate remote, not a rejected lease. Both
      // refuse with CONFLICT — deleting this guard still yields one, because an
      // empty lease (`refs/heads/x:`) is itself unpushable — so a bare `code`
      // assertion passes with the guard gone and proves nothing. This message is
      // the only thing that distinguishes "we never learned the lease authority"
      // from "the branch moved", and it is what the operator is told to act on.
      message: expect.stringContaining("could not determine the remote head"),
    });

    const [attempt] = await attemptRows(runId);

    expect(attempt.phase).toBe("failed");
    expect(attempt.errorCode).toBe("CONFLICT");
    expect(attempt.errorMessage).toContain("could not determine");
    expect(attempt.pushed).not.toBe(true);
    // Never reached `pushing`: the refusal is BEFORE the network call, so no
    // force-push is attempted without an authority to lease against.
    expect(attempt.phase).not.toBe("pushing");

    // The rebase is KEPT (a refused push is not a reason to throw away the work —
    // the live path's lease-rejected branch behaves the same), and origin is
    // untouched: it still carries the pre-sync commit.
    const remoteAfter = await remoteBranchHead({
      projectRepoPath: parent,
      remote: "origin",
      branch: "sync/indeterminate",
    });

    expect(remoteAfter).not.toBe((await headSha(wt)).toLowerCase());
    expect(await syncOperationInProgress(wt)).toBe(false);
    // The claim is released, so the run is not wedged by a refusal.
    const [ws] = await db
      .select()
      .from(workspaces)
      .where(eq(workspaces.runId, runId));

    expect(ws.lifecycleOperationState).toBe("none");
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

    await expect(
      verifySyncGate(wt, targetSha, "sync/gate-ok"),
    ).resolves.toEqual({ ok: true });
  });

  it("fails when the target is not an ancestor of HEAD", async () => {
    const { remote, parent } = await initRepoWithRemote();
    const wt = await addRunWorktree(parent, "sync/gate-bad");

    await advanceOriginMain(remote);
    await git(parent, ["fetch", "origin"]);
    const unrelated = await headSha(parent, "origin/main");
    const res = await verifySyncGate(wt, unrelated, "sync/gate-bad");

    expect(res.ok).toBe(false);
  });

  it("fails on a dirty tree", async () => {
    const { parent } = await initRepoWithRemote();
    const wt = await addRunWorktree(parent, "sync/gate-dirty");
    const targetSha = await headSha(wt);

    await writeFile(join(wt, "dirty.txt"), "x\n");
    const res = await verifySyncGate(wt, targetSha, "sync/gate-dirty");

    expect(res.ok).toBe(false);
  });

  // --- ADR-141 adversarial-review regressions (2026-07-15) -------------------
  // The resolver is only PROMPT-instructed not to push; this gate + the lease are
  // the only ENFORCEMENT. Each case below force-pushed (and, with autoFinalize,
  // merged to the target) before these fixes.

  it("REJECTS conflict markers the resolver COMMITTED (clean tree, marker in HEAD)", async () => {
    const { parent } = await initRepoWithRemote();
    const wt = await addRunWorktree(parent, "sync/gate-markers");
    const targetSha = await headSha(parent, "main");

    // The resolver "resolves" by committing the file verbatim, markers and all,
    // leaving a CLEAN tree with no rebase in progress.
    await writeFile(
      join(wt, "feature.txt"),
      "<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> main\n",
    );
    await git(wt, ["add", "feature.txt"]);
    await git(wt, ["commit", "-m", "resolved (badly)"]);

    const res = await verifySyncGate(wt, targetSha, "sync/gate-markers");

    // A working-tree `git diff --check` sees nothing here — the tree IS clean.
    // The gate must inspect the COMMITTED range instead.
    expect(res).toEqual({
      ok: false,
      reason: "leftover conflict markers remain",
    });
  });

  it("REJECTS a sync that erased the run's own commits (git rebase --skip)", async () => {
    const { parent } = await initRepoWithRemote();
    const wt = await addRunWorktree(parent, "sync/gate-skipped");
    const targetSha = await headSha(parent, "main");

    // `git rebase --skip` (which git's own conflict hint suggests) dropped every
    // commit: the branch is now identical to the target and the user's work is
    // gone. Nothing is in progress, the tree is clean, target IS an ancestor.
    await git(wt, ["reset", "--hard", targetSha]);

    const res = await verifySyncGate(wt, targetSha, "sync/gate-skipped");

    expect(res.ok).toBe(false);
    expect((res as { reason: string }).reason).toContain("erased");
  });

  it("REJECTS a detached HEAD — the push would not carry the verified commit", async () => {
    const { parent } = await initRepoWithRemote();
    const wt = await addRunWorktree(parent, "sync/gate-detached");
    const targetSha = await headSha(parent, "main");

    // `git rebase --quit` leaves HEAD detached on the resolution while
    // refs/heads/<branch> still points at the old tip.
    await git(wt, ["checkout", "--detach", "HEAD"]);

    const res = await verifySyncGate(wt, targetSha, "sync/gate-detached");

    expect(res.ok).toBe(false);
    expect((res as { reason: string }).reason).toContain("HEAD is not on");
  });
});

describe("POST /api/runs/[runId]/sync route", () => {
  // Captured so the authorization CONTRACT can be asserted. The stub used to be
  // anonymous and nothing checked its arguments, so rebinding the route to
  // `readBoard` — letting any viewer force-push a branch — failed nothing.
  let requireProjectActionSpy: ReturnType<typeof vi.fn>;

  async function invokePost(runId: string, body: unknown): Promise<Response> {
    requireProjectActionSpy = vi.fn(async () => undefined);
    vi.doMock("@/lib/authz", () => ({
      requireActiveSession: vi.fn(async () => ({
        id: "user-1",
        role: "member",
      })),
      requireProjectAction: requireProjectActionSpy,
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
    // A sync force-pushes a branch, so it is gated on `promoteRun`, not on a
    // read action — and on the SERVER-DERIVED project id, never a body field.
    expect(requireProjectActionSpy).toHaveBeenCalledWith(
      projectId,
      "promoteRun",
    );
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
