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
