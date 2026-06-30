import type { PlatformStatus } from "@/types/platform-status";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
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
import { testPlatformRunnerRow } from "@/lib/__tests__/runner-fixtures";

// ADR-119 / Phase 2 — atomic attempt-number allocation under concurrent launches.
// Real Postgres (Testcontainers); the git side is mocked so the assertion is the
// per-launch branch/attempt-number distinctness the allocation guarantees, not
// real `git worktree add`. With the OLD stale-read allocation both concurrent
// force-launches of one task compute the SAME `attempt-N` ⇒ identical branch
// (the latent CONFLICT the busy gate used to make unreachable). The atomic
// `UPDATE … RETURNING` makes each launch reserve a DISTINCT number ⇒ distinct
// branch. Mocked-unit tests cannot see this row-level race — it MUST be real PG.

const schema = schemaModule as unknown as Record<string, any>;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

function readyPlatformStatus(): PlatformStatus {
  return {
    kind: "ready",
    health: {
      status: "ready",
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
  async (_args: unknown) => "feedface00000000000000000000000000000000",
);

vi.mock("@/lib/supervisor-client", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/supervisor-client")>();

  return {
    ...actual,
    checkSupervisorHealth: () => checkSupervisorHealthMock(),
  };
});

vi.mock("@/lib/worktree", () => ({
  addWorktree: (input: unknown) => addWorktreeMock(input),
  removeWorktree: (input: unknown) => removeWorktreeMock(input),
  listBranches: (repo: string) => listBranchesMock(repo),
  resolveBaseCommit: (args: unknown) => resolveBaseCommitMock(args),
}));

let launchRun: typeof import("@/lib/services/runs").launchRun;

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
  await db.insert(schema.projects).values({
    taskKey: `T${crypto.randomUUID().slice(0, 8)}`.toUpperCase(),
    id,
    slug,
    name: slug,
    repoPath: `/repos/${slug}`,
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
    installedPath: `/cache/${id}`,
    setupStatus: "not_required",
    packageStatus: "Installed",
  });
  await db.insert(schema.flows).values({
    id: `flow-${id}`,
    projectId: id,
    flowRefId: "bugfix",
    source: "github.com/x/y",
    version: "v1.0.0",
    installedPath: `/cache/${id}`,
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
}

const ctx = {
  actorUserId: "u-member",
  authorize: async () => {},
};

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("relaunch_concurrency_test")
    .withUsername("test")
    .withPassword("test")
    .start();

  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);
  await migrate(db, { migrationsFolder: "./lib/db/migrations" });

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

  ({ launchRun } = await import("@/lib/services/runs"));
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
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

    const [a, b] = await Promise.all([
      launchRun({ taskId: "task-race", allowConcurrent: true }, ctx, db),
      launchRun({ taskId: "task-race", allowConcurrent: true }, ctx, db),
    ]);

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
      launchRun({ taskId: "task-noburn", baseBranch: "ghost-branch" }, ctx, db),
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
