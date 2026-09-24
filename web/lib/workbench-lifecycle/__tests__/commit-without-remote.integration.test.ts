// ADR-181 (`/aif-verify` 2026-09-25): a commit is local, so a repo with no git
// remote must still commit. Commit used to gate on the publish action's id,
// which ADR-181 taught to refuse `no-remote` — so the panel offered Commit and
// the route answered 409. Driven with the DEFAULT deps (the real context and
// its facts) against real Postgres and real git: an injected context without
// facts is exactly what hid it.

import { randomUUID } from "node:crypto";
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

// FIXME(any): dual drizzle-orm peer-dep variants.
const schema = fullSchema as unknown as Record<string, any>;

let db: NodePgDatabase;
let sessionUserId = "";

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));
vi.mock("@/lib/authz", () => ({
  requireActiveSession: vi.fn(async () => ({ id: sessionUserId })),
  requireProjectAction: vi.fn(async () => undefined),
}));

const { exportWorkbenchBranch, snapshotWorkbenchCommit } = await import(
  "@/lib/workbench-lifecycle/service"
);
const { loadGitState } = await import("@/lib/workbench-git/read-model");

let testDatabase: StartedPostgresTestDb;
let root: string;
let repo: BareRemoteRepo;

const USER = randomUUID();

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "workbench_commit_without_remote_test",
  });
  db = testDatabase.db;
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

beforeEach(async () => {
  await clearWorkbenchGitTables(testDatabase.pool);
  await testDatabase.pool.query(`DELETE FROM "users"`);
  await db.insert(schema.users).values({
    id: USER,
    email: `${USER}@maister.test`,
    role: "member",
    accountStatus: "active",
    passwordHash: "x",
  });
  root = await mkdtemp(join(tmpdir(), "wg-no-remote-"));
  repo = await initRepoWithBareRemote(root);
  sessionUserId = USER;
});

afterEach(async () => {
  await rm(root, {
    recursive: true,
    force: true,
    maxRetries: 3,
    retryDelay: 100,
  });
});

// A dirty `Review` worktree whose parent repo has NO remote at all.
async function remotelessReviewRun() {
  const branch = `maister/task-${randomUUID().slice(0, 8)}/attempt-1`;
  const worktree = await addRunWorktree(root, repo.parent, branch);

  await gitIn(repo.parent, ["remote", "remove", "origin"]);
  await writeFile(join(worktree, "feature.txt"), "local edit\n");
  const seed = await seedWorkbenchRun(db, {
    parentRepoPath: repo.parent,
    worktreePath: worktree,
    branch,
    baseCommit: repo.baseSha,
    status: "Review",
  });

  expect(await gitIn(repo.parent, ["remote"])).toBe("");

  return { ...seed, worktree };
}

describe("a commit needs no remote", () => {
  it("commits a remote-less worktree through the default deps", async () => {
    const run = await remotelessReviewRun();

    const result = await snapshotWorkbenchCommit(run.runId, {
      commitMessage: "local only",
    });

    expect(result.snapshotCreated).toBe(true);
    expect(await gitIn(run.worktree, ["log", "-1", "--format=%s"])).toBe(
      "local only",
    );
    expect(await gitIn(run.worktree, ["status", "--porcelain=v1"])).toBe("");
  });

  it("offers Commit in the panel and refuses only the remote-bound publish", async () => {
    const run = await remotelessReviewRun();
    const state = await loadGitState({
      runId: run.runId,
      viewerUserId: USER,
      origin: "http://localhost:3000",
      db: db as never,
    });
    const action = (id: string) =>
      state.actions.find((candidate) => candidate.id === id);

    expect(action("snapshotCommit")).toEqual({
      id: "snapshotCommit",
      enabled: true,
      disabledReason: null,
    });
    expect(action("exportBranch")).toEqual({
      id: "exportBranch",
      enabled: false,
      disabledReason: "no-remote",
    });

    const refusal = await exportWorkbenchBranch(run.runId, {
      remote: "origin",
      snapshotDirty: true,
      commitMessage: "publish",
    }).catch((e: unknown) => e);

    expect(refusal).toBeInstanceOf(MaisterError);
    expect((refusal as MaisterError).code).toBe("PRECONDITION");
    expect((refusal as MaisterError).details?.reason).toBe("no_remote");
  });
});
