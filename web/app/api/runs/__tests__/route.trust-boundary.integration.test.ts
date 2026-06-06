import type { PlatformStatus } from "@/types/platform-status";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { NextRequest } from "next/server";
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
import { testPlatformRunnerRow, testRunnerSnapshot } from "@/lib/__tests__/runner-fixtures";

const schema = schemaModule as unknown as Record<string, any>;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;

// Controllable session. Mocking @/auth also keeps next-auth out of the Vitest
// module graph. The REAL authz layer runs against the test DB, so this exercises
// the actual project-membership trust boundary, not a stub.
const sessionRef: { value: unknown } = { value: null };

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

vi.mock("@/lib/worktree", () => ({
  addWorktree: (input: unknown) => addWorktreeMock(input),
  removeWorktree: (input: unknown) => removeWorktreeMock(input),
  listBranches: async () => ["main"],
  resolveBaseCommit: async () => "0000000000000000000000000000000000000000",
}));

let POST: typeof import("@/app/api/runs/route").POST;

function request(taskId: string): NextRequest {
  return new NextRequest("http://localhost/api/runs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ taskId }),
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
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("runs_tb_test")
    .withUsername("test")
    .withPassword("test")
    .start();

  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);
  await migrate(db, { migrationsFolder: "./lib/db/migrations" });

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

    await db.insert(schema.projects).values({
      id,
      slug,
      name: slug,
      repoPath: `/repos/${slug}`,
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
  await db.insert(schema.platformAcpRunners).values(testPlatformRunnerRow("exec-a", "claude"));
  await db
    .update(schema.projects)
    .set({ defaultRunnerId: "exec-a" })
    .where(eq(schema.projects.id, "proj-a"));
  await db.insert(schema.tasks).values({
    id: "task-in-a",
    projectId: "proj-a",
    title: "A task",
    prompt: "do a",
    flowId: "flow-proj-a",
  });
  // A Backlog task that belongs to project B (NOT A).
  await db.insert(schema.tasks).values({
    id: "task-in-b",
    projectId: "proj-b",
    title: "B task",
    prompt: "do b",
    flowId: "flow-proj-b",
  });

  ({ POST } = await import("@/app/api/runs/route"));
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
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

  it("rejects launching a task whose project the caller is NOT a member of (403)", async () => {
    // userU is a member of project A; the task lives in project B. The route
    // derives the project from the taskId (server-state) and gates on THAT.
    sessionRef.value = { user: { id: "u-member-a", role: "member" } };

    const res = await POST(request("task-in-b"));

    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("UNAUTHORIZED");

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

  it("rejects launch when supervisor readiness is unavailable before worktree or DB side effects", async () => {
    sessionRef.value = { user: { id: "u-member-a", role: "member" } };
    checkSupervisorHealthMock.mockResolvedValueOnce({
      kind: "unavailable",
      reason: "network",
      message: "fetch failed",
    });

    const res = await POST(request("task-in-a"));

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
