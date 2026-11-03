import type { PlatformStatus } from "@/types/platform-status";

import { rm } from "node:fs/promises";

import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { git as fixtureGit } from "@/test-support/git-fixture";
import {
  seedAcceptedRepositoryQualification,
  createEngineFixtureRepository,
  isolateEngineFixtureRuntime,
} from "@/test-support/repository-qualification";
import {
  readyExecutionHostCapabilities,
  TEST_HOST_IDENTITY,
} from "@/test-support/supervisor-health-fixture";
import * as schemaModule from "@/lib/db/schema";
import { testPlatformRunnerRow } from "@/lib/__tests__/runner-fixtures";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";
import {
  launchQualifiedEngineRun as launchRun,
  acceptConcurrentEngineFixture,
  bindClaimedEngineFixture,
} from "@/test-support/launch-engine-response";
import {
  assertTaskLaunchFlowClaim,
  claimTaskLaunchIntent,
} from "@/lib/tasks/launch-dispatch-claim";

// ADR-119: simultaneous authorized concurrent decisions claim distinct attempts
// under real Postgres row locks. Their physical checkout effects then run under
// the actual repository fence; both resulting branches and Run bindings exist.
// A mocked database cannot prove this allocation invariant.

const schema = schemaModule as unknown as Record<string, any>;

let testDatabase: StartedPostgresTestDb;
const repositories: string[] = [];
let restoreEngineRuntime: (() => Promise<void>) | undefined;
let db: NodePgDatabase;

vi.mock("@/auth", () => ({
  auth: async () => ({ user: { id: "u-member" } }),
  signIn: vi.fn(),
  signOut: vi.fn(),
  handlers: {},
}));

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

function readyPlatformStatus(): PlatformStatus {
  return {
    kind: "ready",
    health: {
      status: "ready",
      host: TEST_HOST_IDENTITY,
      version: "0.0.1",
      uptimeMs: 1,
      checkedAt: new Date().toISOString(),
      sessions: { live: 0, exited: 0, crashed: 0 },
    },
  };
}

const checkSupervisorHealthMock = vi.fn<() => Promise<PlatformStatus>>(
  async () => readyPlatformStatus(),
);
const addWorktreeMock = vi.fn(async (_input: unknown) => undefined);
const removeWorktreeMock = vi.fn(async (_input: unknown) => undefined);
const listBranchesMock = vi.fn(async (_repo: string) => ["main", "develop"]);
const resolveBaseCommitMock = vi.fn(
  async (args: { projectRepoPath: string; baseRef: string }) =>
    fixtureGit(
      args.projectRepoPath,
      "rev-parse",
      "--verify",
      `${args.baseRef}^{commit}`,
    ),
);

vi.mock("@/lib/supervisor-client", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/supervisor-client")>();

  return {
    ...actual,
    checkSupervisorHealth: () => checkSupervisorHealthMock(),
    getExecutionHostCapabilities: async () => readyExecutionHostCapabilities(),
  };
});

vi.mock("@/lib/worktree", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/worktree")>();

  return {
    ...actual,
    addWorktree: async (input: Parameters<typeof actual.addWorktree>[0]) => {
      await addWorktreeMock(input);

      return actual.addWorktree(input);
    },
    removeWorktree: async (
      input: Parameters<typeof actual.removeWorktree>[0],
    ) => {
      await removeWorktreeMock(input);

      return actual.removeWorktree(input);
    },
    listBranches: (repo: string) => listBranchesMock(repo),
    resolveBaseCommit: (args: Parameters<typeof resolveBaseCommitMock>[0]) =>
      resolveBaseCommitMock(args),
  };
});

const instructManifest = {
  schemaVersion: 1,
  name: "Instruct",
  nodes: [
    {
      id: "implement",
      type: "ai_coding",
      action: { prompt: "/aif-implement" },
      transitions: { success: "done" },
      settings: { enforcement: { mcps: "instruct" } },
    },
  ],
};

async function seedProject(id: string, slug: string): Promise<void> {
  const repoPath = await createEngineFixtureRepository();

  repositories.push(repoPath);
  await db.insert(schema.projects).values({
    taskKey: `T${crypto.randomUUID().slice(0, 8)}`.toUpperCase(),
    id,
    slug,
    name: slug,
    repoPath,
    mainBranch: "main",
    maisterYamlPath: `/repos/${slug}/maister.yaml`,
  });

  const revisionId = `rev-${id}`;

  await db.insert(schema.flowRevisions).values({
    id: revisionId,
    flowRefId: "bugfix",
    source: "github.com/x/y",
    versionLabel: "v1.0.0",
    resolvedRevision: id.padEnd(40, "x").slice(0, 40),
    manifestDigest: `digest-${id}`,
    manifest: instructManifest,
    schemaVersion: 1,
    installedPath: `${repoPath}/.fixture-flow`,
    setupStatus: "not_required",
    packageStatus: "Installed",
  });
  await db.insert(schema.flows).values({
    id: `flow-${id}`,
    projectId: id,
    flowRefId: "bugfix",
    source: "github.com/x/y",
    version: "v1.0.0",
    installedPath: `${repoPath}/.fixture-flow`,
    manifest: instructManifest,
    schemaVersion: 1,
    enabledRevisionId: revisionId,
    enablementState: "Enabled",
    trustStatus: "trusted_by_policy",
  });
  await db.insert(schema.projectMembers).values({
    id: `pm-${id}`,
    projectId: id,
    userId: "u-member",
    role: "member",
  });
}

async function seedTask(taskId: string, projectId: string): Promise<void> {
  await db.insert(schema.tasks).values({
    number: Math.trunc(Math.random() * 1e9) + 1,
    id: taskId,
    projectId,
    title: "race task",
    prompt: "do it",
    flowId: `flow-${projectId}`,
  });
  await seedAcceptedRepositoryQualification(testDatabase.db, projectId, taskId);
}

const ctx = {
  actorUserId: "u-member",
  authorize: async () => {},
};

beforeAll(async () => {
  restoreEngineRuntime = await isolateEngineFixtureRuntime();
  testDatabase = await startMainPostgresTestDb({
    databaseName: "relaunch_concurrency_test",
  });

  db = testDatabase.db;

  await db.insert(schema.users).values({
    id: "u-member",
    email: "member@test.com",
    role: "member",
    accountStatus: "active",
    passwordHash: "x",
  });
  await db
    .insert(schema.platformAcpRunners)
    .values(testPlatformRunnerRow("claude-default", "claude"));
  await db.insert(schema.platformRuntimeSettings).values({
    id: "singleton",
    defaultRunnerId: "claude-default",
  });
}, 180_000);

afterAll(async () => {
  await restoreEngineRuntime?.();
  await testDatabase?.stop();
  await Promise.all(
    repositories.map((repo) => rm(repo, { recursive: true, force: true })),
  );
});

beforeEach(() => {
  checkSupervisorHealthMock.mockResolvedValue(readyPlatformStatus());
  addWorktreeMock.mockClear();
  removeWorktreeMock.mockClear();
});

describe("launchRun — atomic attempt-number allocation (ADR-119, integration)", () => {
  it("two concurrent force-launches of one task get distinct attempts + branches, both succeed", async () => {
    await seedProject("proj-race", "proj-race");
    await seedTask("task-race", "proj-race");

    const accepted = await Promise.all([
      acceptConcurrentEngineFixture(
        { taskId: "task-race" },
        ctx,
        testDatabase.db,
      ),
      acceptConcurrentEngineFixture(
        { taskId: "task-race" },
        ctx,
        testDatabase.db,
      ),
    ]);
    const claims = await Promise.all(
      accepted.map(({ receipt }) =>
        claimTaskLaunchIntent(testDatabase.db, receipt.intentId),
      ),
    );
    const launched: Array<{ runId: string; status: string }> = [];

    expect(claims).toHaveLength(2);
    for (const claim of claims) {
      if (!claim)
        throw new Error(
          "Concurrent accepted fixture did not acquire its allocation",
        );
      assertTaskLaunchFlowClaim(claim);
      launched.push(await bindClaimedEngineFixture(testDatabase.db, claim));
    }
    const [a, b] = launched;

    // Both launches succeed (no git CONFLICT — distinct branches).
    expect(a.runId).toBeTruthy();
    expect(b.runId).toBeTruthy();
    expect(a.runId).not.toBe(b.runId);

    const runRows = await db
      .select({ id: schema.runs.id })
      .from(schema.runs)
      .where(eq(schema.runs.taskId, "task-race"));

    expect(runRows.length).toBe(2);

    const wsRows = await db
      .select({
        branch: schema.workspaces.branch,
        worktreePath: schema.workspaces.worktreePath,
      })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.projectId, "proj-race"));

    expect(wsRows.length).toBe(2);

    const branches = wsRows.map((w) => w.branch);
    const paths = wsRows.map((w) => w.worktreePath);

    // Distinct branches (the discriminating assertion: stale-read ⇒ identical).
    expect(new Set(branches).size).toBe(2);
    // Distinct worktree paths (runId-keyed — always collision-free).
    expect(new Set(paths).size).toBe(2);
    // Both branches encode `attempt-N` and the two N differ.
    for (const branch of branches) {
      expect(branch).toMatch(/\/attempt-\d+$/);
    }

    // attempt_number bumped twice from the seeded 1 ⇒ 3 (last value reserved).
    const [taskRow] = await db
      .select({ attemptNumber: schema.tasks.attemptNumber })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, "task-race"));

    expect(taskRow.attemptNumber).toBe(3);
  });

  // Codex adversarial-review [high]: the allocator must run AFTER cheap
  // preconditions so a validation refusal never burns a retry-budget number
  // (ralph-loop reads tasks.attempt_number as the max-attempt high-water mark).
  it("a launch refused by branch validation does NOT bump attempt_number (no burned number)", async () => {
    await seedProject("proj-noburn", "proj-noburn");
    await seedTask("task-noburn", "proj-noburn");

    await expect(
      launchRun(
        { taskId: "task-noburn", baseBranch: "ghost-branch" },
        ctx,
        testDatabase.db,
      ),
    ).rejects.toMatchObject({ code: "PRECONDITION" });

    const [taskRow] = await db
      .select({ attemptNumber: schema.tasks.attemptNumber })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, "task-noburn"));

    // Seeded attemptNumber is 1; a refused launch leaves it untouched.
    expect(taskRow.attemptNumber).toBe(1);

    const runRows = await db
      .select({ id: schema.runs.id })
      .from(schema.runs)
      .where(eq(schema.runs.taskId, "task-noburn"));

    expect(runRows.length).toBe(0);
  });
});
