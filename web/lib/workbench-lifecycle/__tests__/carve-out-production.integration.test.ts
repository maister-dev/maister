// ADR-181 D2 (RED 2): the ADR-160 carve-out must OPEN in production. Three
// defects kept it shut: the default deps' `requireActiveSession` discarded the
// user (so `viewerUserId` was always null), and both run-detail read models
// hard-coded the claim owner and viewer to null. Driven with the DEFAULT deps
// (no injected context) against real Postgres and real git.

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

const schema = fullSchema as unknown as Record<string, any>;

let db: NodePgDatabase;
let sessionUserId = "";

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));
vi.mock("@/lib/authz", () => ({
  requireActiveSession: vi.fn(async () => ({ id: sessionUserId })),
  requireProjectAction: vi.fn(async () => undefined),
}));

const { snapshotWorkbenchCommit } = await import(
  "@/lib/workbench-lifecycle/service"
);
const { claimTakeover } = await import("@/lib/flows/graph/ledger");
const { REVIEW_REWORK_CLAIM_DECISION } = await import(
  "@/lib/flows/graph/attempt-decisions"
);

let testDatabase: StartedPostgresTestDb;
let root: string;
let repo: BareRemoteRepo;

const OWNER = randomUUID();
const OTHER = randomUUID();

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "workbench_carve_out_production_test",
  });
  db = testDatabase.db;
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

beforeEach(async () => {
  await clearWorkbenchGitTables(testDatabase.pool);
  await testDatabase.pool.query(`DELETE FROM "users"`);
  for (const id of [OWNER, OTHER]) {
    await db.insert(schema.users).values({
      id,
      email: `${id}@maister.test`,
      role: "member",
      accountStatus: "active",
      passwordHash: "x",
    });
  }
  root = await mkdtemp(join(tmpdir(), "wg-carve-out-"));
  repo = await initRepoWithBareRemote(root);
});

afterEach(async () => {
  await rm(root, {
    recursive: true,
    force: true,
    maxRetries: 3,
    retryDelay: 100,
  });
});

async function claimedRun() {
  const branch = `maister/task-${randomUUID().slice(0, 8)}/attempt-1`;
  const worktree = await addRunWorktree(root, repo.parent, branch);

  await writeFile(join(worktree, "feature.txt"), "operator edit\n");

  const seed = await seedWorkbenchRun(db, {
    parentRepoPath: repo.parent,
    worktreePath: worktree,
    branch,
    baseCommit: repo.baseSha,
    status: "HumanWorking",
  });

  await claimTakeover({
    runId: seed.runId,
    nodeId: "review",
    userId: OWNER,
    nodeType: "human",
    decision: REVIEW_REWORK_CLAIM_DECISION,
    db: db as never,
  });

  return { ...seed, branch, worktree };
}

describe("the rework-claim carve-out, in production", () => {
  it("admits the claim owner's snapshot commit through the default deps", async () => {
    const run = await claimedRun();

    sessionUserId = OWNER;

    const result = await snapshotWorkbenchCommit(run.runId, {
      commitMessage: "operator fix",
    });

    expect(result.snapshotCreated).toBe(true);
    expect(await gitIn(run.worktree, ["log", "-1", "--format=%s"])).toBe(
      "operator fix",
    );
  });

  it("refuses any other member as human_owned, and writes nothing", async () => {
    const run = await claimedRun();
    const head = await gitIn(run.worktree, ["rev-parse", "HEAD"]);

    sessionUserId = OTHER;

    const err = await snapshotWorkbenchCommit(run.runId, {
      commitMessage: "not mine",
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(MaisterError);
    expect((err as MaisterError).code).toBe("PRECONDITION");
    expect((err as MaisterError).details?.reason).toBe("human_owned");
    expect(await gitIn(run.worktree, ["rev-parse", "HEAD"])).toBe(head);
  });

  it("exposes the owner on the run detail and derives the git set for the owner only", async () => {
    const run = await claimedRun();
    const { getRunDetail, lifecycleActionsForViewer } = await import(
      "@/lib/queries/run"
    );
    const detail = await getRunDetail(run.runId);

    expect(detail).not.toBeNull();
    expect(detail!.claimOwnerUserId).toBe(OWNER);
    // The cached, viewer-less projection stays shut for non-detail consumers.
    expect(detail!.lifecycleActions).toEqual([]);

    expect(lifecycleActionsForViewer(detail!, OWNER)).toEqual(
      expect.arrayContaining([
        "exportBranch",
        "snapshotCommit",
        "discardChanges",
        "update",
      ]),
    );
    expect(lifecycleActionsForViewer(detail!, OWNER)).not.toContain("archive");
    expect(lifecycleActionsForViewer(detail!, OTHER)).toEqual([]);
  });

  it("keeps the rail, portfolio and board free of HumanWorking actions", async () => {
    const run = await claimedRun();

    await db.insert(schema.projectMembers).values({
      id: randomUUID(),
      projectId: run.projectId,
      userId: OWNER,
      role: "member",
    });

    const { getRailWorkspaceGroups } = await import("@/lib/queries/portfolio");
    const railRow = (await getRailWorkspaceGroups(OWNER, "member"))
      .flatMap((group) => group.workspaces)
      .find((row) => row.runId === run.runId);

    expect(railRow).toBeDefined();
    expect(railRow!.lifecycleActions).toEqual([]);
  });
});
