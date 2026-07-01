import { randomUUID } from "node:crypto";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
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

import { issueToken } from "@/lib/tokens/issue";
import { testPlatformRunnerRow } from "@/lib/__tests__/runner-fixtures";
import * as schemaModule from "@/lib/db/schema";

const schema = schemaModule as unknown as Record<string, any>;
const auditMockState = vi.hoisted(() => ({
  failSuccessScopes: new Set<string>(),
}));

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));
vi.mock("@/lib/tokens/audit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tokens/audit")>();

  return {
    ...actual,
    recordTokenAudit: vi.fn(
      async (
        input: Parameters<typeof actual.recordTokenAudit>[0],
        d?: Parameters<typeof actual.recordTokenAudit>[1],
      ) => {
        if (
          input.result === "ok" &&
          auditMockState.failSuccessScopes.has(input.scopeUsed)
        ) {
          throw new Error("forced audit failure (atomicity test)");
        }

        return actual.recordTokenAudit(input, d);
      },
    ),
  };
});
vi.mock("@/lib/supervisor-client", () => ({
  checkSupervisorHealth: vi.fn(async () => ({ kind: "available" })),
}));
vi.mock("@/lib/worktree", () => ({
  addWorktree: vi.fn(async () => {}),
  removeWorktree: vi.fn(async () => {}),
  listBranches: vi.fn(async () => ["main"]),
  resolveBaseCommit: vi.fn(
    async () => "0000000000000000000000000000000000000000",
  ),
}));
vi.mock("@/lib/scheduler", () => ({
  tryStartRun: vi.fn(async () => ({ started: false, queuePosition: 1 })),
}));
vi.mock("@/lib/flows/runner", () => ({
  runFlow: vi.fn(async () => {}),
}));

let POST: typeof import("@/app/api/v1/ext/runs/route").POST;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("ext_runs_route_test")
    .withUsername("test")
    .withPassword("test")
    .start();

  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);

  await migrate(db, { migrationsFolder: "./lib/db/migrations" });
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

beforeAll(async () => {
  const routeModule = await import("@/app/api/v1/ext/runs/route");

  POST = routeModule.POST;
});

async function seedProject(slug: string) {
  const projectId = randomUUID();
  const flowId = randomUUID();
  const executorId = randomUUID();
  const revisionId = randomUUID();

  await (db as any).insert(schema.projects).values({
    taskKey: `T${crypto.randomUUID().slice(0, 8)}`.toUpperCase(),
    id: projectId,
    slug,
    name: `Project ${slug}`,
    repoPath: `/tmp/${slug}`,
    maisterYamlPath: `/tmp/${slug}/maister.yaml`,
  });

  await (db as any)
    .insert(schema.platformAcpRunners)
    .values(testPlatformRunnerRow(executorId, "claude"));

  // Set defaultRunnerId after the platform runner row exists.
  await (db as any)
    .update(schema.projects)
    .set({ defaultRunnerId: executorId })
    .where(eq(schema.projects.id, projectId));

  // Runner resolution requires the platform-runtime-settings singleton to exist.
  // Idempotent across multiple seedProject calls (cross-project tests).
  await (db as any)
    .insert(schema.platformRuntimeSettings)
    .values({ id: "singleton", defaultRunnerId: executorId })
    .onConflictDoNothing();

  await (db as any).insert(schema.flowRevisions).values({
    id: revisionId,
    flowRefId: "bugfix",
    source: "github.com/x/y",
    versionLabel: "v1.0.0",
    resolvedRevision: `abc-${revisionId}`,
    manifestDigest: `sha256-${revisionId}`,
    installedPath: "/tmp/flows/bugfix",
    manifest: {
      schemaVersion: 1,
      name: "Bugfix",
      steps: [{ id: "run", type: "cli", command: "echo ok" }],
    },
    schemaVersion: 1,
    packageStatus: "Installed",
    setupStatus: "done",
  });

  await (db as any).insert(schema.flows).values({
    id: flowId,
    projectId,
    flowRefId: "bugfix",
    source: "github.com/x/y",
    version: "v1.0.0",
    installedPath: "/tmp/flows/bugfix",
    manifest: {
      schemaVersion: 1,
      name: "Bugfix",
      steps: [{ id: "run", type: "cli", command: "echo ok" }],
    },
    schemaVersion: 1,
    enabledRevisionId: revisionId,
    enablementState: "Enabled",
    trustStatus: "trusted",
  });

  return { slug, projectId, flowId, executorId };
}

async function seedTask(projectId: string, flowId: string, status = "Backlog") {
  const taskId = randomUUID();

  await (db as any).insert(schema.tasks).values({
    number: Math.trunc(Math.random() * 1e9) + 1,
    id: taskId,
    projectId,
    title: "Test Task",
    prompt: "Do something",
    flowId,
    status,
    stage: status,
    attemptNumber: 1,
  });

  return taskId;
}

function makeRequest(body?: unknown): NextRequest {
  return new NextRequest("http://localhost/api/v1/ext/runs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

beforeEach(async () => {
  auditMockState.failSuccessScopes.clear();
  await db.delete(schema.tokenAuditLog as any);
});

describe("POST /api/v1/ext/runs", () => {
  it("missing/invalid token → 401, no audit row", async () => {
    const { projectId, flowId } = await seedProject(
      `ext-runs-post-${randomUUID().slice(0, 8)}`,
    );
    const taskId = await seedTask(projectId, flowId, "Backlog");

    const req = makeRequest({ taskId });

    req.headers.set("authorization", "Bearer invalid");

    const res = await POST(req, {});

    expect(res.status).toBe(401);

    const auditRows = await db
      .select()
      .from(schema.tokenAuditLog as any)
      .execute();

    expect(auditRows).toHaveLength(0);
  });

  it("task in another project → 404, audit row (wrong-project)", async () => {
    const slug1 = `ext-runs-cross1-${randomUUID().slice(0, 8)}`;
    const slug2 = `ext-runs-cross2-${randomUUID().slice(0, 8)}`;
    const { projectId: proj1 } = await seedProject(slug1);
    const { projectId: proj2, flowId: flow2 } = await seedProject(slug2);

    const taskId = await seedTask(proj2, flow2, "Backlog");

    const token = await issueToken(
      { projectId: proj1, name: "Token for Proj1" },
      db,
    );

    const req = makeRequest({ taskId });

    req.headers.set("authorization", `Bearer ${token.secret}`);

    const res = await POST(req, {});

    expect(res.status).toBe(404);

    const auditRows = await db
      .select()
      .from(schema.tokenAuditLog as any)
      .execute();

    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      result: "error",
      status_code: 404,
      scope_used: "runs:launch",
    });
  });

  it("cross-project task that is NOT in Backlog → 404 (existence-hide, not a 409 state leak)", async () => {
    const { projectId: proj1 } = await seedProject(
      `ext-runs-leak1-${randomUUID().slice(0, 8)}`,
    );
    const { projectId: proj2, flowId: flow2 } = await seedProject(
      `ext-runs-leak2-${randomUUID().slice(0, 8)}`,
    );

    // A task in proj2 that is NOT in Backlog. Without the route's project-scoped
    // pre-check, launchRun's project-unscoped lookup throws "task is not in
    // Backlog" → 409, revealing the task exists in another project + its state.
    const taskId = randomUUID();

    await (db as any).insert(schema.tasks).values({
      number: Math.trunc(Math.random() * 1e9) + 1,
      id: taskId,
      projectId: proj2,
      title: "Other-project task",
      prompt: "x",
      flowId: flow2,
      status: "InFlight",
      stage: "Backlog",
      attemptNumber: 1,
    });

    const token = await issueToken({ projectId: proj1, name: "proj1" }, db);

    const req = makeRequest({ taskId });

    req.headers.set("authorization", `Bearer ${token.secret}`);

    const res = await POST(req, {});

    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe("NOT_FOUND");

    // No run created for the cross-project task.
    const runRows = await (db as any)
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.taskId, taskId))
      .execute();

    expect(runRows).toHaveLength(0);
  });

  it("Backlog task in token's project → 202 {runId, status, queuePosition?}, audit row", async () => {
    const { projectId, flowId } = await seedProject(
      `ext-runs-launch-${randomUUID().slice(0, 8)}`,
    );
    const taskId = await seedTask(projectId, flowId, "Backlog");

    const token = await issueToken({ projectId, name: "Test Token" }, db);

    const req = makeRequest({ taskId });

    req.headers.set("authorization", `Bearer ${token.secret}`);

    const res = await POST(req, {});

    expect(res.status).toBe(202);

    const body = await res.json();

    expect(body).toHaveProperty("runId");
    expect(typeof body.runId).toBe("string");
    expect(body).toHaveProperty("status");

    const auditRows = await db
      .select()
      .from(schema.tokenAuditLog as any)
      .execute();

    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      result: "ok",
      status_code: 202,
      scope_used: "runs:launch",
      endpoint: "POST /api/v1/ext/runs",
    });
  });

  it("accepts deprecated executorOverrideId as a runnerId alias", async () => {
    const { projectId, flowId, executorId } = await seedProject(
      `ext-runs-legacy-runner-${randomUUID().slice(0, 8)}`,
    );
    const taskId = await seedTask(projectId, flowId, "Backlog");
    const token = await issueToken({ projectId, name: "Test Token" }, db);

    const req = makeRequest({ taskId, executorOverrideId: executorId });

    req.headers.set("authorization", `Bearer ${token.secret}`);

    const res = await POST(req, {});

    expect(res.status).toBe(202);

    const body = await res.json();
    const sessionRows = await (db as any)
      .select()
      .from(schema.runSessions)
      .where(eq(schema.runSessions.runId, body.runId))
      .execute();

    expect(sessionRows[0].runnerId).toBe(executorId);
  });

  it("rejects session-only flow and delivery-policy overrides", async () => {
    const { projectId, flowId } = await seedProject(
      `ext-runs-v1-subset-${randomUUID().slice(0, 8)}`,
    );
    const taskId = await seedTask(projectId, flowId, "Backlog");
    const token = await issueToken({ projectId, name: "Test Token" }, db);

    const req = makeRequest({
      taskId,
      flowId,
      deliveryPolicy: {
        strategy: "merge",
        push: "never",
        trigger: "manual",
        targetBranch: "main",
      },
    });

    req.headers.set("authorization", `Bearer ${token.secret}`);

    const res = await POST(req, {});

    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe("CONFIG");

    const runRows = await (db as any)
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.taskId, taskId))
      .execute();

    expect(runRows).toHaveLength(0);
  });

  it("forced success-audit failure rolls back the run launch rows", async () => {
    const { projectId, flowId } = await seedProject(
      `ext-runs-audit-rb-${randomUUID().slice(0, 8)}`,
    );
    const taskId = await seedTask(projectId, flowId, "Backlog");
    const token = await issueToken({ projectId, name: "Test Token" }, db);

    auditMockState.failSuccessScopes.add("runs:launch");

    const req = makeRequest({ taskId });

    req.headers.set("authorization", `Bearer ${token.secret}`);

    await expect(POST(req, {})).rejects.toThrow("forced audit failure");

    const runRows = await (db as any)
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.taskId, taskId))
      .execute();

    expect(runRows).toHaveLength(0);

    const taskRows = await (db as any)
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.id, taskId))
      .execute();

    // ADR-119: attempt_number is allocated atomically BEFORE the launch tx (the
    // sole writer, `UPDATE … attempt_number + 1 RETURNING`) and is intentionally
    // NOT rolled back on a post-allocation failure — a burned monotonic-counter
    // gap with no meaning. The run rows roll back (asserted above) and the task
    // stays Backlog; only the counter advances to 2.
    expect(taskRows[0]).toMatchObject({
      status: "Backlog",
      attemptNumber: 2,
    });

    const auditRows = await db
      .select()
      .from(schema.tokenAuditLog as any)
      .execute();

    expect(auditRows).toHaveLength(0);
  });

  it("user-owned token attributes launched run to the owner user", async () => {
    const { projectId, flowId } = await seedProject(
      `ext-runs-owner-${randomUUID().slice(0, 8)}`,
    );
    const ownerUserId = randomUUID();
    const taskId = await seedTask(projectId, flowId, "Backlog");

    await (db as any).insert(schema.users).values({
      id: ownerUserId,
      email: `run-owner-${ownerUserId.slice(0, 8)}@example.test`,
      role: "member",
      accountStatus: "active",
      passwordHash: "x",
    });

    const token = await issueToken(
      {
        projectId,
        name: "Personal Run Agent",
        tokenKind: "user",
        ownerUserId,
        scopes: ["runs:launch"],
      },
      db,
    );

    const req = makeRequest({ taskId });

    req.headers.set("authorization", `Bearer ${token.secret}`);

    const res = await POST(req, {});

    expect(res.status).toBe(202);

    const body = await res.json();
    const runRows = await (db as any)
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.id, body.runId))
      .execute();

    expect(runRows[0].createdByUserId).toBe(ownerUserId);
  });
});
