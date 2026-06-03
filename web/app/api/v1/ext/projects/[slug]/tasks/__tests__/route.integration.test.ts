import { randomUUID } from "node:crypto";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
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
import * as schemaModule from "@/lib/db/schema";

const schema = schemaModule as unknown as Record<string, any>;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

let POST: typeof import("@/app/api/v1/ext/projects/[slug]/tasks/route").POST;
let GET: typeof import("@/app/api/v1/ext/projects/[slug]/tasks/route").GET;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("ext_tasks_route_test")
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
  const routeModule = await import(
    "@/app/api/v1/ext/projects/[slug]/tasks/route"
  );

  POST = routeModule.POST;
  GET = routeModule.GET;
});

async function seedProject(slug: string) {
  const projectId = randomUUID();
  const flowId = randomUUID();
  const executorId = randomUUID();

  await db.insert(schema.projects).values({
    id: projectId,
    slug,
    name: `Project ${slug}`,
    repoPath: `/tmp/${slug}`,
    maisterYamlPath: `/tmp/${slug}/maister.yaml`,
  });

  await db.insert(schema.flows).values({
    id: flowId,
    projectId,
    flowRefId: "bugfix",
    source: "github.com/x/y",
    version: "v1.0.0",
    installedPath: "/tmp/flows/bugfix",
    manifest: { schemaVersion: 1, name: "Bugfix", steps: [] },
    schemaVersion: 1,
  });

  await db.insert(schema.executors).values({
    id: executorId,
    projectId,
    executorRefId: "claude-sonnet",
    agent: "claude",
    model: "claude-sonnet-4-6",
  });

  return { slug, projectId, flowId, executorId };
}

function makeRequest(method: string, body?: unknown): NextRequest {
  return new NextRequest("http://localhost/api/v1/ext/projects/test/tasks", {
    method,
    headers: { "content-type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

beforeEach(async () => {
  await db.delete(schema.tokenAuditLog as any);
});

describe("POST /api/v1/ext/projects/[slug]/tasks", () => {
  it("missing/invalid token → 401, no audit row", async () => {
    const { slug } = { slug: `ext-tasks-post-${randomUUID().slice(0, 8)}` };

    await seedProject(slug);

    const req = makeRequest("POST", {
      title: "Task",
      prompt: "p",
      flowId: "f",
    });

    // Set invalid bearer header
    req.headers.set("authorization", "Bearer invalid");

    const res = await POST(req, {
      params: Promise.resolve({ slug }),
    });

    expect(res.status).toBe(401);

    const auditCount = await db
      .select()
      .from(schema.tokenAuditLog as any)
      .execute();

    expect(auditCount).toHaveLength(0);
  });

  it("expired token → 401, audit row written", async () => {
    const slug = `ext-tasks-exp-${randomUUID().slice(0, 8)}`;
    const { projectId, flowId } = await seedProject(slug);

    // Issue an expired token
    const expiredToken = await issueToken(
      {
        projectId,
        name: "Expired Token",
        expiresAt: new Date(Date.now() - 1000), // 1 second in the past
      },
      db,
    );

    const req = makeRequest("POST", { title: "Task", prompt: "p", flowId });

    req.headers.set("authorization", `Bearer ${expiredToken.secret}`);

    const res = await POST(req, {
      params: Promise.resolve({ slug }),
    });

    expect(res.status).toBe(401);

    const auditRows = await db
      .select()
      .from(schema.tokenAuditLog as any)
      .execute();

    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      result: "error",
      status_code: 401,
      scope_used: "tasks:create",
    });
  });

  it("valid token, correct project → 201 {taskId}, audit row", async () => {
    const slug = `ext-tasks-create-${randomUUID().slice(0, 8)}`;
    const { projectId, flowId, executorId } = await seedProject(slug);

    const token = await issueToken({ projectId, name: "Test Token" }, db);

    const req = makeRequest("POST", {
      title: "New Task",
      prompt: "Fix the bug",
      flowId,
      executorOverrideId: executorId,
    });

    req.headers.set("authorization", `Bearer ${token.secret}`);

    const res = await POST(req, {
      params: Promise.resolve({ slug }),
    });

    expect(res.status).toBe(201);

    const body = await res.json();

    expect(body).toHaveProperty("taskId");
    expect(typeof body.taskId).toBe("string");

    const auditRows = await db
      .select()
      .from(schema.tokenAuditLog as any)
      .execute();

    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      result: "ok",
      status_code: 201,
      scope_used: "tasks:create",
      endpoint: "POST /api/v1/ext/projects/[slug]/tasks",
    });
  });
});

describe("GET /api/v1/ext/projects/[slug]/tasks", () => {
  it("missing/invalid token → 401, no audit row", async () => {
    const { slug } = { slug: `ext-tasks-get-${randomUUID().slice(0, 8)}` };

    await seedProject(slug);

    const req = makeRequest("GET");

    req.headers.set("authorization", "Bearer invalid");

    const res = await GET(req, {
      params: Promise.resolve({ slug }),
    });

    expect(res.status).toBe(401);

    const auditRows = await db
      .select()
      .from(schema.tokenAuditLog as any)
      .execute();

    expect(auditRows).toHaveLength(0);
  });

  it("valid token, correct project → 200 {tasks: TaskDTO[]}, audit row", async () => {
    const slug = `ext-tasks-list-${randomUUID().slice(0, 8)}`;
    const { projectId, flowId } = await seedProject(slug);

    // Create a task via DB
    const taskId = randomUUID();

    await db.insert(schema.tasks as any).values({
      id: taskId,
      projectId,
      title: "Existing Task",
      prompt: "Fix it",
      flowId,
      status: "Backlog",
      stage: "Backlog",
      attemptNumber: 1,
    });

    const token = await issueToken({ projectId, name: "Test Token" }, db);

    const req = makeRequest("GET");

    req.headers.set("authorization", `Bearer ${token.secret}`);

    const res = await GET(req, {
      params: Promise.resolve({ slug }),
    });

    expect(res.status).toBe(200);

    const body = await res.json();

    expect(Array.isArray(body.tasks)).toBe(true);
    expect(body.tasks.length).toBeGreaterThanOrEqual(1);

    // Verify no leaked fields
    for (const task of body.tasks) {
      expect((task as any).acp_session_id).toBeUndefined();
      expect((task as any).worktree_path).toBeUndefined();
      expect((task as any).token_hash).toBeUndefined();
    }

    const auditRows = await db
      .select()
      .from(schema.tokenAuditLog as any)
      .execute();

    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      result: "ok",
      status_code: 200,
      scope_used: "tasks:read",
    });
  });
});
