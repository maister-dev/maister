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
import { testPlatformRunnerRow } from "@/lib/__tests__/runner-fixtures";
import { BUILT_IN_LANES } from "@/lib/auto-promotion/config";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const execFileAsync = promisify(execFile);

let db: NodePgDatabase;

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

// Keep the worktree revival helpers REAL (addWorktreeForBranch / localBranchHead
// / fetchRemote / remoteTrackingBranchHead / createLocalBranchAt run against the
// per-test git fixtures); stub only the promote/auto-promote git side-effects so
// the re-promote + auto-promote-prefilter assertions never touch a real gh CLI or
// push a real branch.
vi.mock("@/lib/worktree", async (orig) => {
  const actual = await orig<typeof import("@/lib/worktree")>();

  return {
    ...actual,
    // Real, but wrapped: it is the git side effect that runs BEFORE the state
    // transaction, so it is the seam for injecting the tx-fails-after-attach race.
    addWorktreeForBranch: vi.fn(actual.addWorktreeForBranch),
    pushBranch: vi.fn(async () => undefined),
    headCommit: vi.fn(async () => "source-head-000"),
    resolveBaseCommit: vi.fn(async () => "tip00000"),
    squashRunBranch: vi.fn(async () => ({ squashed: false, collapsed: 0 })),
    diffChangeStats: vi.fn(async () => []),
  };
});

// The PR provider seam. `createOrUpdatePr` models the real adapter: it lists open
// PRs and REUSES an existing (source→target) PR, only minting a new number when
// none exists — so `prCreateCount` staying 0 proves reuse-not-create on re-promote.
const prBook = new Map<string, { url: string; number: number }>();
let prCreateCount = 0;
const createOrUpdatePr = vi.fn(
  async (args: { sourceBranch: string; targetBranch: string }) => {
    const key = `${args.sourceBranch}=>${args.targetBranch}`;
    const found = prBook.get(key);

    if (found) return found;
    prCreateCount += 1;
    const pr = {
      url: `https://github.com/org/repo/pull/${900 + prCreateCount}`,
      number: 900 + prCreateCount,
    };

    prBook.set(key, pr);

    return pr;
  },
);
const preflight = vi.fn(async () => undefined);

vi.mock("@/lib/runs/pr-adapter", () => ({
  selectPrAdapter: vi.fn(() => ({ preflight, createOrUpdatePr })),
}));

vi.mock("@/lib/flows/graph/evidence-readiness", () => ({
  assertEvidenceReady: vi.fn(async () => ({ ready: true, reasons: [] })),
}));

vi.mock("@/lib/flows/graph/artifact-store", () => ({
  recordArtifact: vi.fn(async () => undefined),
}));

const { addWorktree, addWorktreeForBranch, removeWorktree, localBranchHead } =
  await import("@/lib/worktree");
const actualWorktree =
  await vi.importActual<typeof import("@/lib/worktree")>("@/lib/worktree");
const { reopenRun, assertReopenEligible } = await import("@/lib/runs/reopen");
const { promoteRun } = await import("@/lib/runs/promote");
const { runAutoPromoteJob } = await import(
  "@/lib/scheduler/handlers/auto-promote"
);
const { deriveStage } = await import("@/lib/board");
const { getOpenRelationBlockers } = await import("@/lib/social/relations");

const schema = fullSchema as unknown as Record<string, any>;
const { runs, workspaces, tasks, taskRelations, webhookEvents } = schema;

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
    "webhook_events",
    "task_relations",
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
  root = await mkdtemp(join(tmpdir(), `reopen-${randomUUID()}-`));
  prBook.clear();
  prCreateCount = 0;
  createOrUpdatePr.mockClear();
  preflight.mockClear();
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

// A bare remote + a working parent clone with `base` committed and pushed.
async function initRepoWithRemote(): Promise<{
  remote: string;
  parent: string;
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

  return { remote, parent };
}

async function addRunWorktree(parent: string, branch: string): Promise<string> {
  const wt = join(root, `wt-${randomUUID()}`);

  await addWorktree({
    projectRepoPath: parent,
    branch,
    worktreePath: wt,
    startPoint: "main",
  });
  await writeFile(join(wt, "feature.txt"), "feature\n");
  await git(wt, ["add", "feature.txt"]);
  await git(wt, ["commit", "-m", "feature commit"]);

  return wt;
}

// ---- seed helpers ---------------------------------------------------------

async function seedGraph(repoPath: string): Promise<{
  projectId: string;
  flowId: string;
}> {
  const projectId = randomUUID();
  const runnerId = randomUUID();
  const flowId = randomUUID();

  await db.insert(schema.projects).values({
    id: projectId,
    slug: `p-${projectId.slice(0, 8)}`,
    name: "P",
    repoPath,
    mainBranch: "main",
    maisterYamlPath: "/tmp/m.yaml",
    provider: "github",
    repoUrl: "https://github.com/org/repo.git",
    autoPromotion: { enabled: true, lanes: BUILT_IN_LANES },
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

  return { projectId, flowId };
}

type SeedRunOpts = {
  projectId: string;
  flowId: string;
  worktreePath: string;
  branch: string;
  parentRepoPath: string;
  status?: string;
  runKind?: "flow" | "agent" | "scratch";
  workspaceMode?: "own" | "shared" | null;
  parentRunId?: string | null;
  taskStatus?: string;
  launchMode?: "auto" | "manual" | null;
  prState?: "open" | "merged" | "closed" | null;
  prHasConflicts?: boolean | null;
  prUrl?: string | null;
  prNumber?: number | null;
  promotionState?: string;
  removedAt?: Date | null;
  archivedAt?: Date | null;
  archivedBranch?: string | null;
  scheduledRemovalAt?: Date | null;
};

async function seedRun(opts: SeedRunOpts): Promise<{
  runId: string;
  taskId: string;
  workspaceId: string;
}> {
  const runId = randomUUID();
  const taskId = randomUUID();
  const workspaceId = randomUUID();
  const isDone = (opts.status ?? "Done") === "Done";

  await db.insert(tasks).values({
    id: taskId,
    projectId: opts.projectId,
    number: Math.trunc(Math.random() * 1e9) + 1,
    title: "t",
    prompt: "p",
    status: opts.taskStatus ?? "InFlight",
    launchMode: opts.launchMode ?? null,
  });
  await db.insert(runs).values({
    id: runId,
    projectId: opts.projectId,
    taskId,
    flowId: opts.flowId,
    flowVersion: "v1.0.0",
    status: opts.status ?? "Done",
    runKind: opts.runKind ?? "flow",
    workspaceMode: opts.workspaceMode ?? null,
    parentRunId: opts.parentRunId ?? null,
    endedAt: isDone ? new Date() : null,
  });
  await db.insert(workspaces).values({
    id: workspaceId,
    runId,
    projectId: opts.projectId,
    branch: opts.branch,
    worktreePath: opts.worktreePath,
    parentRepoPath: opts.parentRepoPath,
    baseBranch: "main",
    baseCommit: "base0000",
    targetBranch: "main",
    promotionMode: "pull_request",
    prState: opts.prState ?? null,
    prHasConflicts: opts.prHasConflicts ?? null,
    prUrl: opts.prUrl ?? null,
    prNumber: opts.prNumber ?? null,
    promotionState: opts.promotionState ?? "done",
    removedAt: opts.removedAt ?? null,
    // `workspaces_removed_result_check` is `removed_at IS NULL OR removal_kind
    // IS NOT NULL` — production never records a removal without saying which
    // kind it was, so a seed that sets only the timestamp is a state the schema
    // rejects. These cases model a retention-GC'd worktree.
    removalKind: opts.removedAt ? "retention_gc" : null,
    archivedAt: opts.archivedAt ?? null,
    archivedBranch: opts.archivedBranch ?? null,
    scheduledRemovalAt:
      opts.scheduledRemovalAt === undefined
        ? new Date(Date.now() + 7 * 86_400_000)
        : opts.scheduledRemovalAt,
  });

  return { runId, taskId, workspaceId };
}

function actor(): { type: "user"; id: string } {
  return { type: "user", id: "user-1" };
}

async function readRun(runId: string): Promise<any> {
  const [row] = await db.select().from(runs).where(eq(runs.id, runId));

  return row;
}

async function readWorkspace(runId: string): Promise<any> {
  const [row] = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.runId, runId));

  return row;
}

async function readTask(taskId: string): Promise<any> {
  const [row] = await db.select().from(tasks).where(eq(tasks.id, taskId));

  return row;
}

// ===========================================================================
// assertReopenEligible — refusal matrix (pure)
// ===========================================================================

describe("assertReopenEligible", () => {
  const ws = { prState: "open", prHasConflicts: null } as any;
  const base = {
    status: "Done",
    runKind: "flow",
    parentRunId: null,
    workspaceMode: null,
  };

  it("passes an eligible top-level Done flow/agent run with an open PR", () => {
    expect(() => assertReopenEligible({ ...base }, ws)).not.toThrow();
    expect(() =>
      assertReopenEligible({ ...base, runKind: "agent" }, ws),
    ).not.toThrow();
  });

  it("passes a Done run whose OPEN PR is conflicted (pr_has_conflicts=true)", () => {
    expect(() =>
      assertReopenEligible({ ...base }, {
        prState: "open",
        prHasConflicts: true,
      } as any),
    ).not.toThrow();
  });

  // A terminal PR cannot be reused: re-promotion's `createOrUpdatePr` finds OPEN
  // PRs only, so reopening onto one would open a SECOND PR and break the
  // "re-promotion MUST reuse the SAME provider PR" expectation. A stale
  // `pr_has_conflicts=true` surviving from the PR's open days must not buy its
  // way past this — that combination is exactly how the hole was reachable.
  it.each(["closed", "merged"] as const)(
    "refuses a %s PR even with a stale conflict flag (re-promotion could not reuse it)",
    (prState) => {
      expect(() =>
        assertReopenEligible({ ...base }, {
          prState,
          prHasConflicts: true,
        } as any),
      ).toThrow(/reusable PR/);
    },
  );

  it("refuses already-Review, child, shared, scratch, and non-PR runs with PRECONDITION", () => {
    const bads: Array<[any, any]> = [
      [{ ...base, status: "Review" }, ws],
      [{ ...base, status: "Running" }, ws],
      [{ ...base, parentRunId: "parent-1" }, ws],
      [{ ...base, workspaceMode: "shared" }, ws],
      [{ ...base, runKind: "scratch" }, ws],
      [{ ...base }, { prState: null, prHasConflicts: null }],
      [{ ...base }, { prState: "merged", prHasConflicts: false }],
      [{ ...base }, { prState: "closed", prHasConflicts: false }],
    ];

    for (const [run, workspace] of bads) {
      expect(() => assertReopenEligible(run, workspace)).toThrowError(
        expect.objectContaining({ code: "PRECONDITION" }),
      );
    }
  });
});

// ===========================================================================
// deriveStage — a reopened run (Review) derives back to OnReview (pure)
// ===========================================================================

describe("deriveStage — reopened run", () => {
  // A reopened run derives to OnReview because `reopenRun` GUARANTEES a present
  // workspace: it re-attaches a GC'd worktree from the surviving branch and
  // clears `removed_at` inside the same transaction that CASes Done → Review
  // (asserted by the round-trip cases above, and documented in
  // system-analytics/branch-sync.md as "card derives to OnReview").
  //
  // This case used to assert OnReview "regardless of worktree presence", which
  // contradicted an explicit, commented board rule — a Review run whose
  // workspace really is gone is historical evidence and belongs in a
  // relaunchable lane, not parked on the review column forever. That
  // combination is unreachable THROUGH reopen, so the test was asserting
  // against the board rule rather than against reopen. Both arms are pinned
  // here so neither side can drift silently.
  it("returns OnReview for a reopened Review run (workspace present, as reopen leaves it)", () => {
    expect(
      deriveStage({
        taskStatus: "InFlight",
        taskStage: "Backlog",
        runStatus: "Review",
        workspaceRemoved: false,
      }),
    ).toBe("OnReview");
  });

  it("still sends a Review run whose workspace is genuinely REMOVED to Backlog", () => {
    expect(
      deriveStage({
        taskStatus: "InFlight",
        taskStage: "Backlog",
        runStatus: "Review",
        workspaceRemoved: true,
      }),
    ).toBe("Backlog");
  });
});

// ===========================================================================
// reopenRun — eligible round-trip + same-PR re-promote (integration)
// ===========================================================================

describe("reopenRun — round-trip", () => {
  it("flips Done→Review, sets promotion_state=reopened, clears removal, stamps review_entered_at, emits run.review; re-promote REUSES the same PR", async () => {
    const { projectId, flowId } = await seedGraph("/repos/demo");
    const branch = "maister/task-1/attempt-1";
    const { runId, taskId, workspaceId } = await seedRun({
      projectId,
      flowId,
      branch,
      worktreePath: "/wt/reopen-1",
      parentRepoPath: "/repos/demo",
      status: "Done",
      taskStatus: "Done",
      prState: "open",
      prUrl: "https://github.com/org/repo/pull/42",
      prNumber: 42,
      promotionState: "done",
    });

    // The provider already has this open PR (source→target) — the adapter reuses it.
    prBook.set(`${branch}=>main`, {
      url: "https://github.com/org/repo/pull/42",
      number: 42,
    });

    const out = await reopenRun({ runId, actor: actor() });

    expect(out).toEqual({ status: "Review", worktreeRevived: false });

    const run = await readRun(runId);

    expect(run.status).toBe("Review");
    expect(run.endedAt).toBeNull();
    expect(run.reviewEnteredAt).not.toBeNull();

    const ws = await readWorkspace(runId);

    expect(ws.promotionState).toBe("reopened");
    expect(ws.scheduledRemovalAt).toBeNull();

    expect((await readTask(taskId)).status).toBe("InFlight");

    const events = await db
      .select()
      .from(webhookEvents)
      .where(eq(webhookEvents.runId, runId));

    expect(events.filter((e: any) => e.type === "run.review")).toHaveLength(1);

    // Re-promote in pull_request mode — canReclaim must admit 'reopened', and the
    // adapter must REUSE the same PR (no new number minted).
    await db
      .insert(fullSchema.users)
      .values({ id: "user-1", email: "reopen-user-1@test.test" })
      .onConflictDoNothing();
    const promoted = (await promoteRun(
      runId,
      { mode: "pull_request", reviewedTargetCommit: "tip00000" },
      {
        sessionUser: { id: "user-1", name: "U", email: "u@test.test" },
        authorize: async () => undefined,
      },
    )) as { ok: boolean; prNumber?: number | null };

    expect(promoted.ok).toBe(true);
    expect(promoted.prNumber).toBe(42);
    expect(createOrUpdatePr).toHaveBeenCalledTimes(1);
    expect(createOrUpdatePr).toHaveBeenCalledWith(
      expect.objectContaining({ sourceBranch: branch, targetBranch: "main" }),
    );
    // Reuse-not-create: the mock never minted a new PR number.
    expect(prCreateCount).toBe(0);

    const wsAfter = await db
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId));

    expect(wsAfter[0].prNumber).toBe(42);
    expect((await readRun(runId)).status).toBe("Done");
  });
});

// ===========================================================================
// reopenRun — GC'd-workspace revival (integration, real git)
// ===========================================================================

describe("reopenRun — GC'd revival", () => {
  it("re-attaches the worktree from the existing branch, clears removed_at, returns worktreeRevived:true", async () => {
    const { parent } = await initRepoWithRemote();
    const { projectId, flowId } = await seedGraph(parent);
    const branch = "maister/task-gc/attempt-1";
    const wt = await addRunWorktree(parent, branch);

    // Simulate GC: unregister + remove the worktree dir, but keep the branch.
    await removeWorktree({
      projectRepoPath: parent,
      worktreePath: wt,
      force: true,
    });
    expect(
      await localBranchHead({ projectRepoPath: parent, branch }),
    ).not.toBeNull();

    const { runId } = await seedRun({
      projectId,
      flowId,
      branch,
      worktreePath: wt,
      parentRepoPath: parent,
      status: "Done",
      taskStatus: "Done",
      prState: "open",
      prUrl: "https://github.com/org/repo/pull/7",
      prNumber: 7,
      promotionState: "done",
      removedAt: new Date(),
      scheduledRemovalAt: new Date(Date.now() + 86_400_000),
    });

    const out = await reopenRun({ runId, actor: actor() });

    expect(out).toEqual({ status: "Review", worktreeRevived: true });

    const ws = await readWorkspace(runId);

    expect(ws.removedAt).toBeNull();
    expect(ws.promotionState).toBe("reopened");
    expect(ws.scheduledRemovalAt).toBeNull();
    expect((await readRun(runId)).status).toBe("Review");

    // The worktree is really registered again at the branch head.
    const listed = await git(parent, ["worktree", "list", "--porcelain"]);

    expect(listed.stdout).toContain(wt);
  });

  // The revival attach is a git side effect that runs BEFORE the state transaction,
  // and nothing rolled it back when that transaction threw. `removed_at` is cleared
  // INSIDE the tx, so it rolls back too — leaving the workspace marked removed while
  // its worktree is attached. No sweep converges that shape: the GC gates candidates
  // on `removed_at IS NULL`, and reconcile skips settled (`Done`) runs. The retry
  // then re-enters the same revival branch and `addWorktreeForBranch` refuses
  // PRECONDITION, so the run was unreopenable without hand-run `git worktree remove`.
  //
  // The trigger modelled here is the most likely one in production and the sharpest
  // irony: the merged-PR re-check that exists to close the duplicate-PR hole, whose
  // own comment notes the window is wide *because* the attach ran inside it.
  it("removes the revived worktree when the transaction fails, so a retry still works", async () => {
    const { parent } = await initRepoWithRemote();
    const { projectId, flowId } = await seedGraph(parent);
    const branch = "maister/task-orphan/attempt-1";
    const wt = await addRunWorktree(parent, branch);

    await removeWorktree({
      projectRepoPath: parent,
      worktreePath: wt,
      force: true,
    });

    const { runId } = await seedRun({
      projectId,
      flowId,
      branch,
      worktreePath: wt,
      parentRepoPath: parent,
      status: "Done",
      taskStatus: "Done",
      prState: "open",
      prUrl: "https://github.com/org/repo/pull/9",
      prNumber: 9,
      promotionState: "done",
      removedAt: new Date(),
    });

    // The supported race: `pr_state_scan`'s merged edge lands in the window the
    // attach itself opened, so the in-tx re-check refuses AFTER the git side effect.
    vi.mocked(addWorktreeForBranch).mockImplementationOnce(async (...args) => {
      await actualWorktree.addWorktreeForBranch(...args);
      await db
        .update(workspaces)
        .set({ prState: "merged", prMergedAt: new Date() })
        .where(eq(workspaces.runId, runId));
    });

    await expect(reopenRun({ runId, actor: actor() })).rejects.toMatchObject({
      code: "PRECONDITION",
    });

    // Compensated: the orphan is gone, and `removed_at` still describes reality.
    const listed = await git(parent, ["worktree", "list", "--porcelain"]);

    expect(listed.stdout).not.toContain(wt);
    expect((await readWorkspace(runId)).removedAt).not.toBeNull();

    // THE point of the fix: the run is still reopenable once the refusal is gone.
    // Asserting only that compensation ran would pass even if retry stayed broken.
    await db
      .update(workspaces)
      .set({ prState: "open", prMergedAt: null })
      .where(eq(workspaces.runId, runId));

    await expect(reopenRun({ runId, actor: actor() })).resolves.toEqual({
      status: "Review",
      worktreeRevived: true,
    });
    expect((await readWorkspace(runId)).removedAt).toBeNull();
  });
});

// ===========================================================================
// reopenRun — service-level refusals (integration)
// ===========================================================================

describe("reopenRun — refusals", () => {
  // ONE representative, deliberately. The refusal TRUTH TABLE (8 cases, a
  // superset of the 4 this used to re-seed) is owned by the pure
  // `assertReopenEligible` describe above; re-enumerating it against a database
  // proves nothing extra, because `reopenRun` reaches the gate through a single
  // call site. What THIS layer must prove is that the wiring exists at all — a
  // service that forgot to call the gate would pass every pure test.
  it("calls the eligibility gate — a non-PR Done run is refused PRECONDITION", async () => {
    const { projectId, flowId } = await seedGraph("/repos/demo");

    const noPr = await seedRun({
      projectId,
      flowId,
      branch: "maister/no-pr",
      worktreePath: "/wt/no-pr",
      parentRepoPath: "/repos/demo",
      status: "Done",
      prState: null,
      prHasConflicts: null,
    });

    await expect(
      reopenRun({ runId: noPr.runId, actor: actor() }),
    ).rejects.toMatchObject({ code: "PRECONDITION" });
  });

  // The eligibility read is lock-free and network I/O runs between it and the
  // transaction, while `pr_state_scan`'s merged edge writes these very columns.
  // The tx re-asserted only `status='Done'` and the workspace UPDATE carried no PR
  // predicate, so a PR that merged inside that window was reopened onto anyway —
  // and re-promotion opens a SECOND PR, defeating the terminal-PR refusal.
  it("refuses when the PR merges between the eligibility read and the transaction", async () => {
    const { projectId, flowId } = await seedGraph("/repos/demo");
    const { runId, workspaceId } = await seedRun({
      projectId,
      flowId,
      branch: "maister/raced",
      worktreePath: "/wt/raced",
      parentRepoPath: "/repos/demo",
      status: "Done",
      prState: "open",
      prHasConflicts: true,
    });

    // Land the concurrent merge in the exact window: a real second connection
    // writes the row after reopen has read it and while it is mid-flight.
    const racingDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "transaction") {
          return async (fn: unknown) => {
            await pool.query(
              `update workspaces
                  set pr_state = 'merged', pr_has_conflicts = false
                where id = $1`,
              [workspaceId],
            );

            return (target as any).transaction(fn);
          };
        }

        return Reflect.get(target, prop, receiver);
      },
    });

    await expect(
      reopenRun({ runId, actor: actor(), db: racingDb }),
    ).rejects.toMatchObject({ code: "PRECONDITION" });

    // The run must be untouched — reopening onto a merged PR is the defect.
    const [row] = await db.select().from(runs).where(eq(runs.id, runId));

    expect(row.status).toBe("Done");
  });
});

// ===========================================================================
// auto-promote — a reopened run is excluded from the lane prefilter
// ===========================================================================

describe("auto-promote prefilter — reopened exclusion", () => {
  it("excludes a promotion_state='reopened' Review flow run from the candidate set", async () => {
    const { projectId, flowId } = await seedGraph("/repos/demo");

    await seedRun({
      projectId,
      flowId,
      branch: "maister/reopened",
      worktreePath: "/wt/reopened",
      parentRepoPath: "/repos/demo",
      status: "Review",
      prState: "open",
      promotionState: "reopened",
    });

    const promote = vi.fn(async () => ({}) as never);
    const summary = await runAutoPromoteJob({ db, promote });

    expect(summary.candidates).toBe(0);
    expect(promote).not.toHaveBeenCalled();
  });

  it("includes an equivalent non-reopened Review flow run (control proving the exclusion)", async () => {
    const { projectId, flowId } = await seedGraph("/repos/demo");

    await seedRun({
      projectId,
      flowId,
      branch: "maister/none",
      worktreePath: "/wt/none",
      parentRepoPath: "/repos/demo",
      status: "Review",
      prState: "open",
      promotionState: "none",
    });

    const promote = vi.fn(async () => ({}) as never);
    const summary = await runAutoPromoteJob({ db, promote });

    expect(summary.candidates).toBe(1);
  });
});

// ===========================================================================
// relations re-gate — a dependent blocked-released on Done re-gates on reopen
// ===========================================================================

describe("reopenRun — relations re-gate", () => {
  it("returns the reopened task to InFlight so getOpenRelationBlockers re-blocks its dependents", async () => {
    const { projectId, flowId } = await seedGraph("/repos/demo");

    // Blocker T (the reopened run's task) currently Done → releases dependents.
    const blocker = await seedRun({
      projectId,
      flowId,
      branch: "maister/blocker",
      worktreePath: "/wt/blocker",
      parentRepoPath: "/repos/demo",
      status: "Done",
      taskStatus: "Done",
      prState: "open",
    });

    // Dependent D is a Backlog task blocked by T (T blocks D).
    const dependentTaskId = randomUUID();

    await db.insert(tasks).values({
      id: dependentTaskId,
      projectId,
      number: Math.trunc(Math.random() * 1e9) + 1,
      title: "d",
      prompt: "p",
      status: "Backlog",
    });
    await db.insert(taskRelations).values({
      id: randomUUID(),
      projectId,
      fromTaskId: blocker.taskId,
      kind: "blocks",
      toTaskId: dependentTaskId,
      actorType: "system",
      actorId: null,
    });

    // Before reopen: T is Done → D has no open blockers.
    const before = await getOpenRelationBlockers([dependentTaskId], db);

    expect(before.get(dependentTaskId) ?? []).toHaveLength(0);

    await reopenRun({ runId: blocker.runId, actor: actor() });

    expect((await readTask(blocker.taskId)).status).toBe("InFlight");

    // After reopen: T is InFlight → D re-gates (T is an open blocker again).
    const after = await getOpenRelationBlockers([dependentTaskId], db);

    expect(after.get(dependentTaskId) ?? []).toHaveLength(1);
  });
});
