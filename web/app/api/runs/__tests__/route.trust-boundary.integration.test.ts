import type { PlatformStatus } from "@/types/platform-status";

import { rm } from "node:fs/promises";

import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  seedAcceptedRepositoryQualification,
  createEngineFixtureRepository,
  isolateEngineFixtureRuntime,
} from "@/test-support/repository-qualification";
import { requireProjectAction } from "@/lib/authz";
import { launchEngineResponse } from "@/test-support/launch-engine-response";
import { TEST_HOST_IDENTITY } from "@/test-support/supervisor-health-fixture";
import * as schemaModule from "@/lib/db/schema";
import { testPlatformRunnerRow } from "@/lib/__tests__/runner-fixtures";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const schema = schemaModule as unknown as Record<string, any>;

let testDatabase: StartedPostgresTestDb;
const repositories: string[] = [];
let restoreEngineRuntime: (() => Promise<void>) | undefined;
let db: NodePgDatabase;

// Controllable session. Mocking @/auth also keeps next-auth out of the Vitest
// module graph. The REAL authz layer runs against the test DB, so this exercises
// the actual project-membership trust boundary, not a stub.
const sessionRef: { value: unknown } = { value: null };

// The real Next request lifecycle runs these callbacks in the browser lane.
// Direct handler tests exercise admission without starting autonomous workers.
vi.mock("next/server", async (original) => ({
  ...(await original<typeof import("next/server")>()),
  after: vi.fn(),
}));

vi.mock("@/auth", () => ({
  auth: vi.fn(async () => sessionRef.value),
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

vi.mock("@/lib/supervisor-client", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/supervisor-client")>();

  return {
    ...actual,
    checkSupervisorHealth: () => checkSupervisorHealthMock(),
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
    listBranches: async () => ["main"],
  };
});

let POST: typeof import("@/app/api/runs/route").POST;

function request(taskId: string): NextRequest {
  return new NextRequest("http://localhost/api/runs", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Origin: "http://localhost",
      "Idempotency-Key": crypto.randomUUID(),
    },
    body: JSON.stringify({
      taskId,
      expectedTaskRevision: 0,
      expectedSettingsToken: "must-not-be-evaluated-before-scope",
    }),
  });
}

async function seedPlatformDefaultRunner(): Promise<void> {
  await db.insert(schema.platformAcpRunners).values({
    id: "claude-default",
    adapter: "claude",
    capabilityAgent: "claude",
    model: "claude-sonnet-4-6",
    provider: { kind: "anthropic" },
    permissionPolicy: "default",
    readinessStatus: "Ready",
    readinessReasons: [],
    enabled: true,
  });
  await db.insert(schema.platformRuntimeSettings).values({
    id: "singleton",
    defaultRunnerId: "claude-default",
  });
}

beforeAll(async () => {
  restoreEngineRuntime = await isolateEngineFixtureRuntime();
  testDatabase = await startMainPostgresTestDb({
    databaseName: "runs_tb_test",
  });

  db = testDatabase.db;

  // Two projects. userU is a member of project A only.
  await db.insert(schema.users).values({
    id: "u-member-a",
    email: "member-a@test.com",
    role: "member",
    accountStatus: "active",
    passwordHash: "x",
  });
  // A member whose account still requires a forced password change.
  await db.insert(schema.users).values({
    id: "u-mustchange",
    email: "mustchange@test.com",
    role: "member",
    accountStatus: "active",
    passwordHash: "x",
    mustChangePassword: true,
  });
  await seedPlatformDefaultRunner();
  for (const [id, slug] of [
    ["proj-a", "proj-a"],
    ["proj-b", "proj-b"],
  ] as const) {
    const manifest = {
      schemaVersion: 1,
      name: "Bugfix",
      nodes: [
        {
          id: "implement",
          type: "ai_coding",
          action: { prompt: "do it" },
          transitions: { success: "done" },
        },
      ],
    };

    const repoPath = await createEngineFixtureRepository();

    repositories.push(repoPath);
    await db.insert(schema.projects).values({
      taskKey: `T${crypto.randomUUID().slice(0, 8)}`.toUpperCase(),
      id,
      slug,
      name: slug,
      repoPath,
      maisterYamlPath: `/repos/${slug}/maister.yaml`,
    });
    // M10: a launchable flow package needs an enabled, trusted, Installed
    // revision so the runs route passes flow-package preconditions and reaches
    // the supervisor-readiness check.
    const revisionId = `rev-${id}`;

    await db.insert(schema.flowRevisions).values({
      id: revisionId,
      flowRefId: "bugfix",
      source: "github.com/x/y",
      versionLabel: "v1.0.0",
      resolvedRevision: (id === "proj-a" ? "a" : "b").repeat(40),
      manifestDigest: `digest-${id}`,
      manifest,
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
      manifest,
      schemaVersion: 1,
      enabledRevisionId: revisionId,
      enablementState: "Enabled",
      trustStatus: "trusted_by_policy",
    });
  }
  await db.insert(schema.projectMembers).values({
    id: "pm-a",
    projectId: "proj-a",
    userId: "u-member-a",
    role: "member",
  });
  await db
    .insert(schema.platformAcpRunners)
    .values(testPlatformRunnerRow("exec-a", "claude"));
  await db
    .update(schema.projects)
    .set({ defaultRunnerId: "exec-a" })
    .where(eq(schema.projects.id, "proj-a"));
  await db.insert(schema.tasks).values({
    number: Math.trunc(Math.random() * 1e9) + 1,
    id: "task-in-a",
    projectId: "proj-a",
    title: "A task",
    prompt: "do a",
    flowId: "flow-proj-a",
  });
  // A Backlog task that belongs to project B (NOT A).
  await db.insert(schema.tasks).values({
    number: Math.trunc(Math.random() * 1e9) + 1,
    id: "task-in-b",
    projectId: "proj-b",
    title: "B task",
    prompt: "do b",
    flowId: "flow-proj-b",
  });

  await seedAcceptedRepositoryQualification(
    testDatabase.db,
    "proj-a",
    "task-in-a",
  );
  ({ POST } = await import("@/app/api/runs/route"));
}, 180_000);

afterAll(async () => {
  await restoreEngineRuntime?.();
  await testDatabase?.stop();
  await Promise.all(
    repositories.map((repo) => rm(repo, { recursive: true, force: true })),
  );
});

describe("POST /api/runs — project-membership trust boundary (integration)", () => {
  beforeEach(() => {
    checkSupervisorHealthMock.mockResolvedValue(readyPlatformStatus());
    addWorktreeMock.mockClear();
    removeWorktreeMock.mockClear();
  });

  it("rejects an anonymous caller with 401", async () => {
    sessionRef.value = null;

    const res = await POST(request("task-in-b"));

    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe("UNAUTHENTICATED");
  });

  it("blocks a forced-password-change caller BEFORE task probing (403 PASSWORD_CHANGE_REQUIRED)", async () => {
    // Auth-first: a must-change account hitting a NONEXISTENT task must get the
    // password-change gate (403 PASSWORD_CHANGE_REQUIRED), NOT a PRECONDITION
    // "task not found" (409) shape-leak. Proves account-state precedes any
    // resource read.
    sessionRef.value = { user: { id: "u-mustchange", role: "member" } };

    const res = await POST(request("does-not-exist"));

    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("PASSWORD_CHANGE_REQUIRED");
  });

  it("does not disclose a task outside the caller's current project scope (404)", async () => {
    // userU is a member of project A; the task lives in project B. The route
    // derives the project from the taskId (server-state) and gates on THAT.
    sessionRef.value = { user: { id: "u-member-a", role: "member" } };

    const res = await POST(request("task-in-b"));

    expect(res.status).toBe(404);
    expect((await res.json()).details.reason).toBe("launch_not_found");

    // The deny happens before any worktree/run side-effect.
    const runs = await db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.taskId, "task-in-b"));

    expect(runs).toHaveLength(0);

    const task = await db
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.id, "task-in-b"));

    expect(task[0].status).toBe("Backlog");
  });

  it("delivery engine rejects launch when supervisor readiness is unavailable before worktree or DB side effects", async () => {
    sessionRef.value = { user: { id: "u-member-a", role: "member" } };
    checkSupervisorHealthMock.mockResolvedValueOnce({
      kind: "unavailable",
      reason: "network",
      message: "fetch failed",
    });

    const res = await launchEngineResponse(
      testDatabase.db,
      { taskId: "task-in-a" },
      {
        actorUserId: "u-member-a",
        authorize: async (projectId, action = "launchRun") => {
          await requireProjectAction(projectId, action);
        },
      },
    );

    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe("EXECUTOR_UNAVAILABLE");
    expect(addWorktreeMock).not.toHaveBeenCalled();

    const workspaces = await db
      .select()
      .from(schema.workspaces)
      .where(eq(schema.workspaces.projectId, "proj-a"));

    expect(workspaces).toHaveLength(0);

    const runs = await db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.taskId, "task-in-a"));

    expect(runs).toHaveLength(0);

    const task = await db
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.id, "task-in-a"));

    expect(task[0].status).toBe("Backlog");
  });
});
