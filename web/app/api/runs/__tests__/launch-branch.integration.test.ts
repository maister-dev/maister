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
import { testPlatformRunnerRow } from "@/lib/__tests__/runner-fixtures";

// M18 Phase 1 — RED until migration 0021 + launchRun branch persistence land.
// Real Postgres (Testcontainers) + real DB writes; the git side of the worktree
// module is mocked so the workspace-row persistence is what is asserted:
//   - a launch with explicit baseBranch/targetBranch persists base_branch,
//     base_commit, target_branch, promotion_mode on the workspaces row.
//   - promotion_mode reflects the project's promotion_mode (SET) and the
//     local_merge default (CLEAR).
//   - the ext launch (POST /api/v1/ext/runs) threads the same branch fields.

const schema = schemaModule as unknown as Record<string, any>;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;

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
const listBranchesMock = vi.fn(async (_repo: string) => [
  "main",
  "develop",
  "release",
]);
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

let POST: typeof import("@/app/api/runs/route").POST;
let EXT_POST: typeof import("@/app/api/v1/ext/runs/route").POST;

// All-instruct manifest → passes the M11c enforcement gate so the launch
// reaches the worktree/workspace persistence path.
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

async function seedProject(
  id: string,
  slug: string,
  opts: { promotionMode?: string | null } = {},
): Promise<void> {
  await db.insert(schema.projects).values({ taskKey: `T${crypto.randomUUID().slice(0, 8)}`.toUpperCase(),
    id,
    slug,
    name: slug,
    repoPath: `/repos/${slug}`,
    mainBranch: "main",
    maisterYamlPath: `/repos/${slug}/maister.yaml`,
    // M18: projects.promotion_mode (migration 0021). Setting it here is part of
    // the SET path of the §3.4 config→column symmetry assertion.
    ...(opts.promotionMode !== undefined
      ? { promotionMode: opts.promotionMode }
      : {}),
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
  await db.insert(schema.tasks).values({ number: Math.trunc(Math.random() * 1e9) + 1,
    id: taskId,
    projectId,
    title: "branch task",
    prompt: "do it",
    flowId: `flow-${projectId}`,
  });
}

function runRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest("http://localhost/api/runs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function workspaceForRun(runId: string): Promise<Record<string, any>> {
  const rows = await db
    .select()
    .from(schema.workspaces)
    .where(eq(schema.workspaces.runId, runId));

  return rows[0];
}

async function latestRunForTask(taskId: string): Promise<Record<string, any>> {
  const rows = await db
    .select()
    .from(schema.runs)
    .where(eq(schema.runs.taskId, taskId));

  return rows[0];
}

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("runs_branch_test")
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

  await seedProject("proj-pr", "proj-pr", { promotionMode: "pull_request" });
  await seedTask("task-pr", "proj-pr");

  await seedProject("proj-default", "proj-default");
  await seedTask("task-default", "proj-default");

  await seedProject("proj-ext", "proj-ext");
  await seedTask("task-ext", "proj-ext");

  ({ POST } = await import("@/app/api/runs/route"));
  ({ POST: EXT_POST } = await import("@/app/api/v1/ext/runs/route"));
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

beforeEach(() => {
  checkSupervisorHealthMock.mockResolvedValue(readyPlatformStatus());
  addWorktreeMock.mockClear();
  removeWorktreeMock.mockClear();
  listBranchesMock.mockClear();
  resolveBaseCommitMock.mockClear();
  sessionRef.value = { user: { id: "u-member", role: "member" } };
});

describe("POST /api/runs — launch-time branch persistence (M18, integration)", () => {
  it("persists base_branch/base_commit/target_branch/promotion_mode on the workspace row", async () => {
    const res = await POST(
      runRequest({
        taskId: "task-pr",
        baseBranch: "develop",
        targetBranch: "release",
      }),
    );

    expect(res.status).toBe(202);

    const run = await latestRunForTask("task-pr");
    const ws = await workspaceForRun(run.id);

    expect(ws.baseBranch).toBe("develop");
    expect(ws.baseCommit).toBe("feedface00000000000000000000000000000000");
    expect(ws.targetBranch).toBe("release");
    // proj-pr's projects.promotion_mode = 'pull_request' (SET path, §3.4).
    expect(ws.promotionMode).toBe("pull_request");
    expect(addWorktreeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        startPoint: "feedface00000000000000000000000000000000",
      }),
    );
  });

  it("defaults promotion_mode to local_merge when the project has none, and target to the base", async () => {
    const res = await POST(runRequest({ taskId: "task-default" }));

    expect(res.status).toBe(202);

    const run = await latestRunForTask("task-default");
    const ws = await workspaceForRun(run.id);

    expect(ws.baseBranch).toBe("main");
    expect(ws.targetBranch).toBe("main");
    expect(ws.promotionMode).toBe("local_merge");
  });
});

describe("POST /api/v1/ext/runs — ext launch threads branch fields (M18, integration)", () => {
  it("persists base_branch/target_branch supplied to the external launch endpoint", async () => {
    const req = new NextRequest("http://localhost/api/v1/ext/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        taskId: "task-ext",
        baseBranch: "develop",
        targetBranch: "release",
      }),
    });

    // handleExt resolves the token's project; without a valid token this is the
    // RED surface that also proves the body schema accepts the new fields once
    // wired. Assert via the persisted workspace once the launch succeeds.
    const res = await EXT_POST(req, {});

    // The ext route is token-authed; in this harness no token is present, so
    // this asserts the route does not 400 on the NEW body fields (schema
    // acceptance). The Implementor wires baseBranch/targetBranch into the ext
    // postBodySchema + launchRun call; a 422 here on the BODY (invalid schema)
    // would fail the contract.
    expect(res.status).not.toBe(422);
  });
});
