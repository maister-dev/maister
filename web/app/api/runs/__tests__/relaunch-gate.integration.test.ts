import type { PlatformStatus } from "@/types/platform-status";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { NextRequest } from "next/server";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import * as schemaModule from "@/lib/db/schema";
import { testPlatformRunnerRow } from "@/lib/__tests__/runner-fixtures";

// ADR-119 / Phase 3 — the allowConcurrent body flag selects the force gate, and
// GET /api/runs/launch-options carries the additive `relaunch` verdict. Real
// Postgres; git/supervisor mocked. The force gate widens ONLY the run-status
// gate (busy → launchable) — it NEVER bypasses the task gates flagged/blocked.

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

let POST: typeof import("@/app/api/runs/route").POST;
let LAUNCH_OPTIONS_GET: typeof import("@/app/api/runs/launch-options/route").GET;

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

async function seedTask(
  taskId: string,
  projectId: string,
  opts: { triageStatus?: string; status?: string } = {},
): Promise<void> {
  await db.insert(schema.tasks).values({
    number: Math.trunc(Math.random() * 1e9) + 1,
    id: taskId,
    projectId,
    title: "gate task",
    prompt: "do it",
    flowId: `flow-${projectId}`,
    ...(opts.triageStatus ? { triageStatus: opts.triageStatus } : {}),
    ...(opts.status ? { status: opts.status } : {}),
  });
}

function postRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest("http://localhost/api/runs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function launchOptionsRequest(taskId: string): NextRequest {
  return new NextRequest(
    `http://localhost/api/runs/launch-options?taskId=${taskId}`,
  );
}

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("relaunch_gate_test")
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

  await seedProject("proj-gate", "proj-gate");
  await seedTask("task-busy", "proj-gate");

  // A blocked task: a Backlog blocker task X `blocks` it.
  await seedTask("task-blocked", "proj-gate");
  await seedTask("task-blocker", "proj-gate", { status: "Backlog" });
  await db.insert(schema.taskRelations).values({
    id: "rel-1",
    projectId: "proj-gate",
    fromTaskId: "task-blocker",
    kind: "blocks",
    toTaskId: "task-blocked",
    actorType: "user",
    actorId: "u-member",
  });

  // A flagged task.
  await seedTask("task-flagged", "proj-gate", { triageStatus: "flagged" });

  ({ POST } = await import("@/app/api/runs/route"));
  ({ GET: LAUNCH_OPTIONS_GET } = await import(
    "@/app/api/runs/launch-options/route"
  ));
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

beforeEach(() => {
  checkSupervisorHealthMock.mockResolvedValue(readyPlatformStatus());
  addWorktreeMock.mockClear();
  sessionRef.value = { user: { id: "u-member", role: "member" } };
});

describe("POST /api/runs — allowConcurrent gate (ADR-119, integration)", () => {
  it("a busy task: absent allowConcurrent is refused PRECONDITION; allowConcurrent:true succeeds", async () => {
    // First launch makes the task busy (latest run Pending/Running).
    const first = await POST(postRequest({ taskId: "task-busy" }));

    expect(first.status).toBe(202);

    // Manual gate (default) refuses while busy.
    const refused = await POST(postRequest({ taskId: "task-busy" }));

    expect(refused.status).toBe(409);
    expect((await refused.json()).code).toBe("PRECONDITION");

    // Force gate launches an additive concurrent run.
    const forced = await POST(
      postRequest({ taskId: "task-busy", allowConcurrent: true }),
    );

    expect(forced.status).toBe(202);
  });

  it("a blocked task: allowConcurrent:true is STILL refused PRECONDITION (task gate not bypassed)", async () => {
    const res = await POST(
      postRequest({ taskId: "task-blocked", allowConcurrent: true }),
    );

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("PRECONDITION");
  });

  it("a flagged task: allowConcurrent:true is STILL refused PRECONDITION", async () => {
    const res = await POST(
      postRequest({ taskId: "task-flagged", allowConcurrent: true }),
    );

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("PRECONDITION");
  });
});

describe("GET /api/runs/launch-options — relaunch field (ADR-119, integration)", () => {
  it("a busy task: launchability is busy/not-launchable but relaunch is launchable", async () => {
    const res = await LAUNCH_OPTIONS_GET(launchOptionsRequest("task-busy"));

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      launchability: { launchable: boolean; reason: string };
      relaunch: { launchable: boolean; reason: string };
    };

    expect(body.launchability.launchable).toBe(false);
    expect(body.launchability.reason).toBe("busy");
    expect(body.relaunch.launchable).toBe(true);
    expect(body.relaunch.reason).toBe("launchable");
  });

  it("a blocked task: relaunch.reason is blocked", async () => {
    const res = await LAUNCH_OPTIONS_GET(launchOptionsRequest("task-blocked"));
    const body = (await res.json()) as {
      relaunch: { launchable: boolean; reason: string };
    };

    expect(body.relaunch.launchable).toBe(false);
    expect(body.relaunch.reason).toBe("blocked");
  });

  it("a flagged task: relaunch.reason is flagged", async () => {
    const res = await LAUNCH_OPTIONS_GET(launchOptionsRequest("task-flagged"));
    const body = (await res.json()) as {
      relaunch: { launchable: boolean; reason: string };
    };

    expect(body.relaunch.launchable).toBe(false);
    expect(body.relaunch.reason).toBe("flagged");
  });
});
