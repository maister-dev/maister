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

const schema = schemaModule as unknown as Record<string, any>;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;

// Controllable session — the REAL authz layer runs against the test DB.
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
}));

let POST: typeof import("@/app/api/runs/route").POST;

function request(taskId: string): NextRequest {
  return new NextRequest("http://localhost/api/runs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ taskId }),
  });
}

// Manifest whose pinned revision declares an ai_coding node with a strict
// enforcement intent on a class the M11c table can only INSTRUCT → launch must
// REFUSE with CONFIG (400, the existing httpStatusForCode mapping).
const strictManifest = {
  schemaVersion: 1,
  name: "Strict",
  nodes: [
    {
      id: "implement",
      type: "ai_coding",
      action: { prompt: "/aif-implement" },
      transitions: { success: "done" },
      settings: { enforcement: { mcps: "strict" } },
    },
  ],
};

// A judge node carrying strict mcps — also capability-bearing → also refused.
const strictJudgeManifest = {
  schemaVersion: 1,
  name: "StrictJudge",
  nodes: [
    {
      id: "verdict",
      type: "judge",
      action: { prompt: "/judge" },
      transitions: { success: "done" },
      settings: { enforcement: { mcps: "strict" } },
    },
  ],
};

// All-instruct manifest → launch must proceed past the enforcement gate.
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

async function seedProjectWithManifest(
  id: string,
  slug: string,
  manifest: unknown,
): Promise<void> {
  await db.insert(schema.projects).values({
    id,
    slug,
    name: slug,
    repoPath: `/repos/${slug}`,
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
  await db.insert(schema.executors).values({
    id: `exec-${id}`,
    projectId: id,
    executorRefId: "claude-default",
    agent: "claude",
    model: "claude-sonnet-4-6",
  });
  await db
    .update(schema.projects)
    .set({ defaultExecutorId: `exec-${id}` })
    .where(eq(schema.projects.id, id));
  await db.insert(schema.projectMembers).values({
    id: `pm-${id}`,
    projectId: id,
    userId: "u-member",
    role: "member",
  });
  await db.insert(schema.tasks).values({
    id: `task-${id}`,
    projectId: id,
    title: `${slug} task`,
    prompt: "do it",
    flowId: `flow-${id}`,
  });
}

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("runs_enf_test")
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

  await seedProjectWithManifest("proj-strict", "proj-strict", strictManifest);
  await seedProjectWithManifest(
    "proj-judge",
    "proj-judge",
    strictJudgeManifest,
  );
  await seedProjectWithManifest(
    "proj-instruct",
    "proj-instruct",
    instructManifest,
  );

  ({ POST } = await import("@/app/api/runs/route"));
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

describe("POST /api/runs — settings-enforcement launch refusal (integration)", () => {
  beforeEach(() => {
    checkSupervisorHealthMock.mockResolvedValue(readyPlatformStatus());
    addWorktreeMock.mockClear();
    removeWorktreeMock.mockClear();
    sessionRef.value = { user: { id: "u-member", role: "member" } };
  });

  it("refuses a strict-mcps ai_coding manifest with 400 CONFIG and NO side-effect", async () => {
    const res = await POST(request("task-proj-strict"));

    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("CONFIG");

    // The refusal runs BEFORE worktree creation — no worktree, no run, no
    // workspace, task stays Backlog.
    expect(addWorktreeMock).not.toHaveBeenCalled();

    const runs = await db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.taskId, "task-proj-strict"));

    expect(runs).toHaveLength(0);

    const workspaces = await db
      .select()
      .from(schema.workspaces)
      .where(eq(schema.workspaces.projectId, "proj-strict"));

    expect(workspaces).toHaveLength(0);

    const task = await db
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.id, "task-proj-strict"));

    expect(task[0].status).toBe("Backlog");
  });

  it("refuses a strict-mcps judge manifest with 400 CONFIG too", async () => {
    const res = await POST(request("task-proj-judge"));

    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("CONFIG");
    expect(addWorktreeMock).not.toHaveBeenCalled();

    const runs = await db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.taskId, "task-proj-judge"));

    expect(runs).toHaveLength(0);
  });

  it("an all-instruct manifest launches cleanly (202, creates runs + workspaces rows)", async () => {
    const res = await POST(request("task-proj-instruct"));

    expect(res.status).toBe(202);
    expect(addWorktreeMock).toHaveBeenCalledTimes(1);

    const runRows = await db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.taskId, "task-proj-instruct"));

    expect(runRows).toHaveLength(1);

    const workspaceRows = await db
      .select()
      .from(schema.workspaces)
      .where(eq(schema.workspaces.runId, runRows[0].id));

    expect(workspaceRows).toHaveLength(1);

    const task = await db
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.id, "task-proj-instruct"));

    expect(task[0].status).toBe("InFlight");
  });
});
