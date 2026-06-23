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

  await db.insert(schema.projects).values({ taskKey: `T${crypto.randomUUID().slice(0, 8)}`.toUpperCase(),
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

async function seedUser(emailPrefix: string): Promise<string> {
  const userId = randomUUID();

  await db.insert(schema.users).values({
    id: userId,
    email: `${emailPrefix}-${userId.slice(0, 8)}@example.test`,
    role: "member",
    accountStatus: "active",
    passwordHash: "x",
  });

  return userId;
}

async function seedProjectMember(
  projectId: string,
  userId: string,
  role: "owner" | "admin" | "member" | "viewer" = "member",
): Promise<void> {
  await db.insert(schema.projectMembers).values({
    projectId,
    userId,
    role,
  });
}

async function seedTask(projectId: string, flowId: string, title: string) {
  const taskId = randomUUID();

  await db.insert(schema.tasks as any).values({
    number: Math.trunc(Math.random() * 1e9) + 1,
    id: taskId,
    projectId,
    title,
    prompt: "Fix it",
    flowId,
    status: "Backlog",
    stage: "Backlog",
    attemptNumber: 1,
  });

  return taskId;
}

async function issueGlobalUserToken(
  ownerUserId: string,
  scopes: Parameters<typeof issueToken>[0]["scopes"],
) {
  return issueToken(
    {
      projectId: null as unknown as string,
      name: "Global Personal Token",
      tokenKind: "user",
      ownerUserId,
      scopes,
    },
    db,
  );
}

function makeRequest(method: string, body?: unknown): NextRequest {
  return new NextRequest("http://localhost/api/v1/ext/projects/test/tasks", {
    method,
    headers: { "content-type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

beforeEach(async () => {
  auditMockState.failSuccessScopes.clear();
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
    const { projectId, flowId } = await seedProject(slug);

    const token = await issueToken({ projectId, name: "Test Token" }, db);

    const req = makeRequest("POST", {
      title: "New Task",
      prompt: "Fix the bug",
      flowId,
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

  it("forced success-audit failure rolls back the task insert", async () => {
    const slug = `ext-tasks-audit-rb-${randomUUID().slice(0, 8)}`;
    const { projectId, flowId } = await seedProject(slug);
    const token = await issueToken({ projectId, name: "Test Token" }, db);

    auditMockState.failSuccessScopes.add("tasks:create");

    const req = makeRequest("POST", {
      title: "Audit rollback task",
      prompt: "Do not persist",
      flowId,
    });

    req.headers.set("authorization", `Bearer ${token.secret}`);

    await expect(
      POST(req, {
        params: Promise.resolve({ slug }),
      }),
    ).rejects.toThrow("forced audit failure");

    const taskRows = await db
      .select()
      .from(schema.tasks as any)
      .where(eq((schema.tasks as any).title, "Audit rollback task"))
      .execute();

    expect(taskRows).toHaveLength(0);

    const auditRows = await db
      .select()
      .from(schema.tokenAuditLog as any)
      .execute();

    expect(auditRows).toHaveLength(0);
  });

  it("token missing tasks:create scope → 403, audit row, no task", async () => {
    const slug = `ext-tasks-scope-${randomUUID().slice(0, 8)}`;
    const { projectId, flowId } = await seedProject(slug);

    const token = await issueToken(
      {
        projectId,
        name: "Read-only Token",
        scopes: ["tasks:read"],
      },
      db,
    );

    const req = makeRequest("POST", {
      title: "Blocked Task",
      prompt: "Do not create",
      flowId,
    });

    req.headers.set("authorization", `Bearer ${token.secret}`);

    const res = await POST(req, {
      params: Promise.resolve({ slug }),
    });

    expect(res.status).toBe(403);

    const taskRows = await db
      .select()
      .from(schema.tasks as any)
      .where(eq((schema.tasks as any).title, "Blocked Task"))
      .execute();
    const blockedTasks = taskRows.filter(
      (row: any) => row.title === "Blocked Task" && row.projectId === projectId,
    );

    expect(blockedTasks).toHaveLength(0);

    const auditRows = await db
      .select()
      .from(schema.tokenAuditLog as any)
      .execute();

    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      result: "error",
      status_code: 403,
      scope_used: "tasks:create",
    });
  });

  it("user-owned token attributes created task to the owner user", async () => {
    const slug = `ext-tasks-owner-${randomUUID().slice(0, 8)}`;
    const { projectId, flowId } = await seedProject(slug);
    const ownerUserId = randomUUID();

    await db.insert(schema.users).values({
      id: ownerUserId,
      email: `owner-${slug}@example.test`,
      role: "member",
      accountStatus: "active",
      passwordHash: "x",
    });

    const token = await issueToken(
      {
        projectId,
        name: "Personal Agent",
        tokenKind: "user",
        ownerUserId,
        scopes: ["tasks:create"],
      },
      db,
    );

    const req = makeRequest("POST", {
      title: "Owned Task",
      prompt: "Create with owner",
      flowId,
    });

    req.headers.set("authorization", `Bearer ${token.secret}`);

    const res = await POST(req, {
      params: Promise.resolve({ slug }),
    });

    expect(res.status).toBe(201);

    const body = await res.json();
    const taskRows = await db
      .select()
      .from(schema.tasks as any)
      .where(eq((schema.tasks as any).id, body.taskId))
      .execute();
    const [task] = taskRows.filter((row: any) => row.id === body.taskId);

    expect(task.createdByUserId).toBe(ownerUserId);
  });

  it("global user token creates a task only in the URL-derived project", async () => {
    const ownerUserId = await seedUser("global-task-create");
    const allowed = await seedProject(
      `ext-tasks-global-create-${randomUUID().slice(0, 8)}`,
    );
    const other = await seedProject(
      `ext-tasks-global-body-${randomUUID().slice(0, 8)}`,
    );

    await seedProjectMember(allowed.projectId, ownerUserId);

    const token = await issueGlobalUserToken(ownerUserId, ["tasks:create"]);
    const req = makeRequest("POST", {
      title: "Body project must not win",
      prompt: "Create in the URL project",
      flowId: other.flowId,
    });

    req.headers.set("authorization", `Bearer ${token.secret}`);

    const res = await POST(req, {
      params: Promise.resolve({ slug: allowed.slug }),
    });

    expect(res.status).toBe(422);

    const taskRows = await db
      .select()
      .from(schema.tasks as any)
      .where(eq((schema.tasks as any).title, "Body project must not win"))
      .execute();

    expect(taskRows).toHaveLength(0);

    const auditRows = await db
      .select()
      .from(schema.tokenAuditLog as any)
      .execute();

    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      result: "error",
      status_code: 422,
      project_id: allowed.projectId,
      scope_used: "tasks:create",
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

    await db.insert(schema.tasks as any).values({ number: Math.trunc(Math.random() * 1e9) + 1,
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

  it("global user token lists tasks in an owner-visible project", async () => {
    const slug = `ext-tasks-global-list-${randomUUID().slice(0, 8)}`;
    const ownerUserId = await seedUser("global-task-list");
    const { projectId, flowId } = await seedProject(slug);

    await seedProjectMember(projectId, ownerUserId);

    const taskId = await seedTask(projectId, flowId, "Visible global task");
    const token = await issueGlobalUserToken(ownerUserId, ["tasks:read"]);
    const req = makeRequest("GET");

    req.headers.set("authorization", `Bearer ${token.secret}`);

    const res = await GET(req, {
      params: Promise.resolve({ slug }),
    });

    expect(res.status).toBe(200);

    const body = await res.json();

    expect(body.tasks).toContainEqual(
      expect.objectContaining({ id: taskId, title: "Visible global task" }),
    );

    const auditRows = await db
      .select()
      .from(schema.tokenAuditLog as any)
      .execute();

    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      result: "ok",
      status_code: 200,
      project_id: projectId,
      scope_used: "tasks:read",
    });
  });

  it("global user token existence-hides projects outside owner access", async () => {
    const ownerUserId = await seedUser("global-task-hidden");
    const visible = await seedProject(
      `ext-tasks-global-visible-${randomUUID().slice(0, 8)}`,
    );
    const hidden = await seedProject(
      `ext-tasks-global-hidden-${randomUUID().slice(0, 8)}`,
    );

    await seedProjectMember(visible.projectId, ownerUserId);
    await seedTask(hidden.projectId, hidden.flowId, "Hidden global task");

    const token = await issueGlobalUserToken(ownerUserId, ["tasks:read"]);
    const req = makeRequest("GET");

    req.headers.set("authorization", `Bearer ${token.secret}`);

    const res = await GET(req, {
      params: Promise.resolve({ slug: hidden.slug }),
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
      project_id: hidden.projectId,
      scope_used: "tasks:read",
    });
  });
});
