// ADR-181 D20 (RED 11): ONE writer per worktree. Publish and discard race on the
// same workspace. Both pass their pre-claim checks with the slot free — the
// barrier below PROVES the window is open — and then contend at the lifecycle
// claim, which is the only thing standing between two conflicting git effects.
// Real Postgres (the FOR UPDATE is the lock under test) and real git.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type NodePgDatabase } from "drizzle-orm/node-postgres";
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
import {
  addRunWorktree,
  gitIn,
  initRepoWithBareRemote,
  remoteHead,
  type BareRemoteRepo,
} from "@/test-support/git-remote-fixture";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";
import {
  clearWorkbenchGitTables,
  seedWorkbenchRun,
  workspaceRow,
} from "@/test-support/workbench-git-seed";

vi.mock("@/lib/worktree", async (orig) => {
  const actual = await orig<typeof import("@/lib/worktree")>();

  return {
    ...actual,
    statusPorcelain: vi.fn(actual.statusPorcelain),
    snapshotDirtyWorktree: vi.fn(actual.snapshotDirtyWorktree),
    writeRescueRef: vi.fn(actual.writeRescueRef),
  };
});

let db: NodePgDatabase;

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));
vi.mock("@/lib/authz", () => ({
  requireActiveSession: vi.fn(async () => ({ id: "user-1" })),
  requireProjectAction: vi.fn(async () => undefined),
}));

const worktreeModule = await import("@/lib/worktree");
const actual =
  await vi.importActual<typeof import("@/lib/worktree")>("@/lib/worktree");
const { exportWorkbenchBranch } = await import(
  "@/lib/workbench-lifecycle/service"
);
const { discardWorkbenchChanges } = await import("@/lib/workbench-git/service");
const { depsFromOptions } = await import("@/lib/workbench-lifecycle/service");
const { syncRunTarget } = await import("@/lib/runs/sync-target");
const { claimTakeover } = await import("@/lib/flows/graph/ledger");
const { REVIEW_REWORK_CLAIM_DECISION } = await import(
  "@/lib/flows/graph/attempt-decisions"
);

const schema = fullSchema as unknown as Record<string, any>;

// The default deps load `@/lib/authz` lazily, and vitest 2.1.9 skips a manual
// mock when the importer's shared callstack already holds it: two racers taking
// that import concurrently hand the second one the REAL module (which then
// fails loading next-auth). The race under test is the lifecycle claim, so the
// session and role checks are injected; every other dep — the fact loader, the
// FOR UPDATE claim, git — is the production default.
function raceDeps() {
  return {
    ...depsFromOptions(undefined),
    requireActiveSession: async () => ({ id: "user-1" }),
    authorize: async () => undefined,
  };
}

let testDatabase: StartedPostgresTestDb;
let root: string;
let repo: BareRemoteRepo;

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "workbench_git_race_test",
  });
  db = testDatabase.db;
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

beforeEach(async () => {
  await clearWorkbenchGitTables(testDatabase.pool);
  root = await mkdtemp(join(tmpdir(), "wg-race-"));
  repo = await initRepoWithBareRemote(root);
});

afterEach(async () => {
  vi.mocked(worktreeModule.statusPorcelain).mockImplementation(
    actual.statusPorcelain,
  );
  vi.mocked(worktreeModule.snapshotDirtyWorktree).mockImplementation(
    actual.snapshotDirtyWorktree,
  );
  vi.mocked(worktreeModule.writeRescueRef).mockImplementation(
    actual.writeRescueRef,
  );
  await rm(root, {
    recursive: true,
    force: true,
    maxRetries: 3,
    retryDelay: 100,
  });
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });

  return { promise, resolve };
}

async function dirtyRun(i: number) {
  const branch = `maister/task-race-${i}/attempt-1`;
  const worktree = await addRunWorktree(root, repo.parent, branch);

  await writeFile(join(worktree, "feature.txt"), `race ${i}\n`);

  const seed = await seedWorkbenchRun(db, {
    parentRepoPath: repo.parent,
    worktreePath: worktree,
    branch,
    baseCommit: repo.baseSha,
    status: "Failed",
    taskKey: "RACE",
    task: { number: 100 + i, title: `race ${i}` },
  });

  return { ...seed, branch, worktree };
}

describe("publish vs discard on one workspace", () => {
  // Repeated with a fresh workspace each time so both winners are exercised.
  it.each([1, 2, 3])(
    "round %i: exactly one git effect runs; the other racer is CONFLICT",
    async (i) => {
      const run = await dirtyRun(i);

      // Both racers must be past their pre-claim checks before either may
      // claim: that is the window the claim has to close.
      // The first arrival is held until the second: the second arrival can
      // only be the OTHER racer, so `windowOpen` proves both were past their
      // checks with the slot free. Later calls (a post-claim re-check) pass.
      let preClaimArrivals = 0;
      let windowOpen = false;
      const bothArrived = deferred();

      vi.mocked(worktreeModule.statusPorcelain).mockImplementation(
        async (args) => {
          preClaimArrivals += 1;
          if (preClaimArrivals === 2) {
            windowOpen = true;
            bothArrived.resolve();
          }
          await bothArrived.promise;

          return actual.statusPorcelain(args);
        },
      );

      // The winner's first git effect waits until the loser has settled, so the
      // loser's claim attempt provably overlaps the winner's hold. Without the
      // guard both would reach this point; the timeout keeps that failure from
      // hanging the suite.
      let effectsReached = 0;
      const firstSettled = deferred();
      const effectGate = Promise.race([
        firstSettled.promise,
        new Promise<void>((r) => setTimeout(r, 3_000)),
      ]);

      vi.mocked(worktreeModule.snapshotDirtyWorktree).mockImplementation(
        async (args) => {
          effectsReached += 1;
          await effectGate;

          return actual.snapshotDirtyWorktree(args);
        },
      );
      vi.mocked(worktreeModule.writeRescueRef).mockImplementation(
        async (args) => {
          effectsReached += 1;
          await effectGate;

          return actual.writeRescueRef(args);
        },
      );

      const publish = exportWorkbenchBranch(run.runId, {
        remote: "origin",
        branchName: null,
        snapshotDirty: true,
        commitMessage: "snapshot before publish",
        force: false,
        deps: raceDeps(),
      }).finally(firstSettled.resolve);
      const discard = discardWorkbenchChanges(run.runId, {
        deps: raceDeps(),
      }).finally(firstSettled.resolve);

      const results = await Promise.allSettled([publish, discard]);

      expect(windowOpen).toBe(true);
      expect(effectsReached).toBe(1);

      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter(
        (r): r is PromiseRejectedResult => r.status === "rejected",
      );

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0].reason).toBeInstanceOf(MaisterError);
      expect((rejected[0].reason as MaisterError).code).toBe("CONFLICT");

      // The outcome is exactly ONE of the two effects, never a blend.
      const published =
        (await remoteHead(repo.remote, `feature/RACE-${100 + i}-race-${i}`)) !==
        null;
      const rescued = await gitIn(repo.parent, [
        "for-each-ref",
        `refs/maister/rescue/${run.runId}/`,
      ]);

      expect(published).not.toBe(rescued !== "");
    },
  );
});

// The plan's Follow-up "Recover does not respect the workspace lifecycle slot":
// the claim recorded `expectedRunStatus` and never compared it, so an operation
// admitted on a `Crashed` run still claimed the tree after a recover had put an
// agent back into it. The claim now decides on the run's status under the run's
// own lock — the order the sync claim takes (workspace, then run).
describe("a lifecycle claim against a status that moved", () => {
  it("refuses a discard admitted on a Crashed run that a recover flipped to Running before the claim", async () => {
    const branch = "maister/task-race-recover/attempt-1";
    const worktree = await addRunWorktree(root, repo.parent, branch);

    await writeFile(join(worktree, "feature.txt"), "agent work in progress\n");

    const run = await seedWorkbenchRun(db, {
      parentRepoPath: repo.parent,
      worktreePath: worktree,
      branch,
      baseCommit: repo.baseSha,
      status: "Crashed",
      taskKey: "RACE",
      task: { number: 200, title: "recover race" },
    });

    // The discard is past its admission (the policy read `Crashed`) and its
    // dirty check; the recover commits `Crashed -> Running` right there, and the
    // next thing the discard does is claim.
    let admitted = false;

    vi.mocked(worktreeModule.statusPorcelain).mockImplementation(
      async (args) => {
        if (!admitted) {
          admitted = true;
          await testDatabase.pool.query(
            `UPDATE runs SET status = 'Running' WHERE id = $1`,
            [run.runId],
          );
        }

        return actual.statusPorcelain(args);
      },
    );

    const outcome = await discardWorkbenchChanges(run.runId, {
      deps: raceDeps(),
    }).catch((err: unknown) => err);

    expect(admitted).toBe(true);
    expect(outcome).toBeInstanceOf(MaisterError);
    expect(outcome).toMatchObject({
      code: "CONFLICT",
      details: { reason: "busy" },
    });
    // Nothing of the agent's tree was touched: no rescue ref, no reset, and the
    // slot was never taken.
    expect(
      await gitIn(repo.parent, [
        "for-each-ref",
        `refs/maister/rescue/${run.runId}/`,
      ]),
    ).toBe("");
    expect(
      await gitIn(worktree, ["status", "--porcelain", "--", "feature.txt"]),
    ).not.toBe("");
    expect(
      (await workspaceRow(db, run.workspaceId)).lifecycleOperationState,
    ).toBe("none");
  });
});

// ADR-181 D2: a HumanWorking operation is admitted for the open rework claim's
// owner. A release and a re-claim between the admission and the claim leave the
// status `HumanWorking` — a status re-check under the lock cannot see that the
// tree now belongs to someone else, so both claims re-check the OWNER there.
describe("a HumanWorking claim that changed hands before the claim", () => {
  const OWNER = "user-1";
  const NEXT = "user-2";

  async function claimedRun(i: number, dirty: boolean) {
    for (const id of [OWNER, NEXT]) {
      await db
        .insert(schema.users)
        .values({
          id,
          email: `${id}@maister.test`,
          role: "member",
          accountStatus: "active",
          passwordHash: "x",
        })
        .onConflictDoNothing();
    }

    const branch = `maister/task-race-owner-${i}/attempt-1`;
    const worktree = await addRunWorktree(root, repo.parent, branch);

    if (dirty) {
      await writeFile(join(worktree, "feature.txt"), "operator edit\n");
    }

    const seed = await seedWorkbenchRun(db, {
      parentRepoPath: repo.parent,
      worktreePath: worktree,
      branch,
      baseCommit: repo.baseSha,
      status: "HumanWorking",
      taskKey: "RACE",
      task: { number: 300 + i, title: `owner race ${i}` },
    });
    const claim = await claimTakeover({
      runId: seed.runId,
      nodeId: "review",
      userId: OWNER,
      nodeType: "human",
      decision: REVIEW_REWORK_CLAIM_DECISION,
      db: db as never,
    });

    return { ...seed, branch, worktree, claimId: claim.id };
  }

  // Past the admission (the policy read OWNER's claim), before the claim: the
  // owner returns the run and NEXT claims it again — same status, new owner.
  function handOverAtTheDirtyCheck(run: { runId: string; claimId: string }) {
    let handedOver = false;

    vi.mocked(worktreeModule.statusPorcelain).mockImplementation(
      async (args) => {
        if (!handedOver) {
          handedOver = true;
          await testDatabase.pool.query(
            `UPDATE node_attempts SET ended_at = now(), status = 'Succeeded' WHERE id = $1`,
            [run.claimId],
          );
          await claimTakeover({
            runId: run.runId,
            nodeId: "review",
            userId: NEXT,
            nodeType: "human",
            decision: REVIEW_REWORK_CLAIM_DECISION,
            db: db as never,
          });
        }

        return actual.statusPorcelain(args);
      },
    );

    return () => handedOver;
  }

  it("refuses the former owner's discard as human_owned, touching nothing", async () => {
    const run = await claimedRun(1, true);
    const handedOver = handOverAtTheDirtyCheck(run);

    const outcome = await discardWorkbenchChanges(run.runId, {
      deps: raceDeps(),
    }).catch((err: unknown) => err);

    expect(handedOver()).toBe(true);
    expect(outcome).toBeInstanceOf(MaisterError);
    expect(outcome).toMatchObject({
      code: "PRECONDITION",
      details: { reason: "human_owned" },
    });
    expect(
      await gitIn(repo.parent, [
        "for-each-ref",
        `refs/maister/rescue/${run.runId}/`,
      ]),
    ).toBe("");
    expect(
      await gitIn(run.worktree, ["status", "--porcelain", "--", "feature.txt"]),
    ).not.toBe("");
    expect(
      (await workspaceRow(db, run.workspaceId)).lifecycleOperationState,
    ).toBe("none");
  });

  it("refuses the former owner's update as human_owned, minting no sync attempt", async () => {
    const run = await claimedRun(2, false);
    const handedOver = handOverAtTheDirtyCheck(run);

    const outcome = await syncRunTarget({
      runId: run.runId,
      admission: "workbench",
      actor: { type: "user", id: OWNER },
      db: db as never,
    }).catch((err: unknown) => err);

    expect(handedOver()).toBe(true);
    expect(outcome).toBeInstanceOf(MaisterError);
    expect(outcome).toMatchObject({
      code: "PRECONDITION",
      details: { reason: "human_owned" },
    });
    expect(
      (
        await testDatabase.pool.query(
          `SELECT count(*)::int AS n FROM run_sync_attempts WHERE run_id = $1`,
          [run.runId],
        )
      ).rows[0].n,
    ).toBe(0);
    expect(
      (await workspaceRow(db, run.workspaceId)).lifecycleOperationState,
    ).toBe("none");
  });
});
