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

let GET: typeof import("@/app/api/v1/ext/projects/[slug]/tasks/[taskId]/route").GET;
let PATCH: typeof import("@/app/api/v1/ext/projects/[slug]/tasks/[taskId]/route").PATCH;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("ext_tasks_id_route_test")
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
    "@/app/api/v1/ext/projects/[slug]/tasks/[taskId]/route"
  );

  GET = routeModule.GET;
  PATCH = routeModule.PATCH;
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

  await db
    .insert(schema.platformAcpRunners)
    .values(testPlatformRunnerRow(executorId, "claude"));

  return { slug, projectId, flowId, executorId };
}

async function seedTask(projectId: string, flowId: string, status = "Backlog") {
  const taskId = randomUUID();

  await db.insert(schema.tasks as any).values({
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

function makeRequest(
  method: string,
  taskId: string,
  body?: unknown,
): NextRequest {
  return new NextRequest(
    `http://localhost/api/v1/ext/projects/test/tasks/${taskId}`,
    {
      method,
      headers: { "content-type": "application/json" },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    },
  );
}

beforeEach(async () => {
  auditMockState.failSuccessScopes.clear();
  await db.delete(schema.tokenAuditLog as any);
});

describe("GET /api/v1/ext/projects/[slug]/tasks/[taskId]", () => {
  it("missing/invalid token → 401, no audit row", async () => {
    const { slug, projectId, flowId } = {
      ...(await seedProject(`ext-task-get-${randomUUID().slice(0, 8)}`)),
    };
    const taskId = await seedTask(projectId, flowId);

    const req = makeRequest("GET", taskId);

    req.headers.set("authorization", "Bearer invalid");

    const res = await GET(req, {
      params: Promise.resolve({ slug, taskId }),
    });

    expect(res.status).toBe(401);

    const auditRows = await db
      .select()
      .from(schema.tokenAuditLog as any)
      .execute();

    expect(auditRows).toHaveLength(0);
  });

  it("valid token, wrong-project taskId → 404, audit row", async () => {
    const slug1 = `ext-task-cross1-${randomUUID().slice(0, 8)}`;
    const slug2 = `ext-task-cross2-${randomUUID().slice(0, 8)}`;
    const { projectId: proj1 } = await seedProject(slug1);
    const { projectId: proj2, flowId: flow2 } = await seedProject(slug2);

    const taskId = await seedTask(proj2, flow2);

    const token = await issueToken(
      { projectId: proj1, name: "Token for Proj1" },
      db,
    );

    const req = makeRequest("GET", taskId);

    req.headers.set("authorization", `Bearer ${token.secret}`);

    const res = await GET(req, {
      params: Promise.resolve({ slug: slug1, taskId }),
    });

    expect(res.status).toBe(404);

    const auditRows = await db
      .select()
      .from(schema.tokenAuditLog as any)
      .execute();

    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      result: "error",
      status_code: 404,
      scope_used: "tasks:read",
    });
  });

  it("valid token, correct taskId → 200 TaskDTO, audit row, no leaked fields", async () => {
    const { slug, projectId, flowId } = {
      ...(await seedProject(`ext-task-detail-${randomUUID().slice(0, 8)}`)),
    };
    const taskId = await seedTask(projectId, flowId);

    const token = await issueToken({ projectId, name: "Test Token" }, db);

    const req = makeRequest("GET", taskId);

    req.headers.set("authorization", `Bearer ${token.secret}`);

    const res = await GET(req, {
      params: Promise.resolve({ slug, taskId }),
    });

    expect(res.status).toBe(200);

    const body = await res.json();

    expect(body).toHaveProperty("id", taskId);
    expect(body).toHaveProperty("title");
    expect(body).toHaveProperty("prompt");
    expect(body).toHaveProperty("status");
    expect(body).toHaveProperty("flowId");

    // Verify no leaked fields
    expect((body as any).acp_session_id).toBeUndefined();
    expect((body as any).worktree_path).toBeUndefined();
    expect((body as any).token_hash).toBeUndefined();

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

describe("PATCH /api/v1/ext/projects/[slug]/tasks/[taskId]", () => {
  it("missing/invalid token → 401, no audit row", async () => {
    const { slug, projectId, flowId } = {
      ...(await seedProject(`ext-patch-${randomUUID().slice(0, 8)}`)),
    };
    const taskId = await seedTask(projectId, flowId);

    const req = makeRequest("PATCH", taskId, { title: "Updated" });

    req.headers.set("authorization", "Bearer invalid");

    const res = await PATCH(req, {
      params: Promise.resolve({ slug, taskId }),
    });

    expect(res.status).toBe(401);

    const auditRows = await db
      .select()
      .from(schema.tokenAuditLog as any)
      .execute();

    expect(auditRows).toHaveLength(0);
  });

  it("valid token, Backlog task → 200 TaskDTO updated, audit row", async () => {
    const { slug, projectId, flowId } = {
      ...(await seedProject(`ext-patch-ok-${randomUUID().slice(0, 8)}`)),
    };
    const taskId = await seedTask(projectId, flowId, "Backlog");

    const token = await issueToken({ projectId, name: "Test Token" }, db);

    const req = makeRequest("PATCH", taskId, {
      title: "Updated Title",
      prompt: "New prompt",
    });

    req.headers.set("authorization", `Bearer ${token.secret}`);

    const res = await PATCH(req, {
      params: Promise.resolve({ slug, taskId }),
    });

    expect(res.status).toBe(200);

    const body = await res.json();

    expect(body).toHaveProperty("id", taskId);
    expect(body).toHaveProperty("title", "Updated Title");
    expect(body).toHaveProperty("prompt", "New prompt");

    const auditRows = await db
      .select()
      .from(schema.tokenAuditLog as any)
      .execute();

    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      result: "ok",
      status_code: 200,
      scope_used: "tasks:update",
    });
  });

  it("forced success-audit failure rolls back the task update", async () => {
    const { slug, projectId, flowId } = {
      ...(await seedProject(`ext-patch-audit-rb-${randomUUID().slice(0, 8)}`)),
    };
    const taskId = await seedTask(projectId, flowId, "Backlog");
    const token = await issueToken({ projectId, name: "Test Token" }, db);

    auditMockState.failSuccessScopes.add("tasks:update");

    const req = makeRequest("PATCH", taskId, {
      title: "Should Not Persist",
      prompt: "Should not persist either",
    });

    req.headers.set("authorization", `Bearer ${token.secret}`);

    await expect(
      PATCH(req, {
        params: Promise.resolve({ slug, taskId }),
      }),
    ).rejects.toThrow("forced audit failure");

    const taskRows = await db
      .select()
      .from(schema.tasks as any)
      .where(eq((schema.tasks as any).id, taskId))
      .execute();

    expect(taskRows[0]).toMatchObject({
      title: "Test Task",
      prompt: "Do something",
    });

    const auditRows = await db
      .select()
      .from(schema.tokenAuditLog as any)
      .execute();

    expect(auditRows).toHaveLength(0);
  });

  it("valid token, non-Backlog task → 409 PRECONDITION error, audit row", async () => {
    const { slug, projectId, flowId } = {
      ...(await seedProject(`ext-patch-409-${randomUUID().slice(0, 8)}`)),
    };
    const taskId = await seedTask(projectId, flowId, "InFlight");

    const token = await issueToken({ projectId, name: "Test Token" }, db);

    const req = makeRequest("PATCH", taskId, { title: "Try to update" });

    req.headers.set("authorization", `Bearer ${token.secret}`);

    const res = await PATCH(req, {
      params: Promise.resolve({ slug, taskId }),
    });

    expect(res.status).toBe(409);

    const auditRows = await db
      .select()
      .from(schema.tokenAuditLog as any)
      .execute();

    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      result: "error",
      status_code: 409,
      scope_used: "tasks:update",
    });
  });
});
