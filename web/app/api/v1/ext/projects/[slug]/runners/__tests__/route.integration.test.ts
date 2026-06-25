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
import { testPlatformRunnerRow } from "@/lib/__tests__/runner-fixtures";
import * as schemaModule from "@/lib/db/schema";

const schema = schemaModule as unknown as Record<string, any>;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

let GET: typeof import("@/app/api/v1/ext/projects/[slug]/runners/route").GET;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("ext_runners_route_test")
    .withUsername("test")
    .withPassword("test")
    .start();

  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);

  await migrate(db, { migrationsFolder: "./lib/db/migrations" });

  const routeModule = await import(
    "@/app/api/v1/ext/projects/[slug]/runners/route"
  );

  GET = routeModule.GET;
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

async function seedProject(slug: string): Promise<string> {
  const projectId = randomUUID();

  await db.insert(schema.projects).values({
    taskKey: `T${randomUUID().slice(0, 8)}`.toUpperCase(),
    id: projectId,
    slug,
    name: `Project ${slug}`,
    repoPath: `/tmp/${slug}`,
    maisterYamlPath: `/tmp/${slug}/maister.yaml`,
  });

  return projectId;
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
): Promise<void> {
  await db.insert(schema.projectMembers).values({
    projectId,
    userId,
    role: "member",
  });
}

function makeRequest(slug: string): NextRequest {
  return new NextRequest(
    `http://localhost/api/v1/ext/projects/${slug}/runners`,
    {
      method: "GET",
      headers: { "content-type": "application/json" },
    },
  );
}

beforeEach(async () => {
  await db.delete(schema.tokenAuditLog as any);
  await db.delete(schema.platformAcpRunners as any);
});

describe("GET /api/v1/ext/projects/[slug]/runners", () => {
  it("missing/invalid token → 401, no audit row", async () => {
    const slug = `ext-runners-401-${randomUUID().slice(0, 8)}`;

    await seedProject(slug);

    const req = makeRequest(slug);

    req.headers.set("authorization", "Bearer invalid");

    const res = await GET(req, { params: Promise.resolve({ slug }) });

    expect(res.status).toBe(401);

    const auditRows = await db
      .select()
      .from(schema.tokenAuditLog as any)
      .execute();

    expect(auditRows).toHaveLength(0);
  });

  it("token missing runners:read scope → 403, audit row", async () => {
    const slug = `ext-runners-403-${randomUUID().slice(0, 8)}`;
    const projectId = await seedProject(slug);

    const token = await issueToken(
      { projectId, name: "No-runners Token", scopes: ["tasks:read"] },
      db,
    );

    const req = makeRequest(slug);

    req.headers.set("authorization", `Bearer ${token.secret}`);

    const res = await GET(req, { params: Promise.resolve({ slug }) });

    expect(res.status).toBe(403);

    const auditRows = await db
      .select()
      .from(schema.tokenAuditLog as any)
      .execute();

    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      result: "error",
      status_code: 403,
      scope_used: "runners:read",
    });
  });

  it("valid token → 200 with the EXACT enabled-only projection + audit row", async () => {
    const slug = `ext-runners-ok-${randomUUID().slice(0, 8)}`;
    const projectId = await seedProject(slug);

    const enabledId = randomUUID();
    const disabledId = randomUUID();

    await db
      .insert(schema.platformAcpRunners)
      .values({ ...testPlatformRunnerRow(enabledId, "claude"), enabled: true });
    // Disabled runner — MUST be excluded from the projection.
    await db.insert(schema.platformAcpRunners).values({
      ...testPlatformRunnerRow(disabledId, "codex"),
      enabled: false,
    });

    const token = await issueToken({ projectId, name: "Discovery Token" }, db);
    const req = makeRequest(slug);

    req.headers.set("authorization", `Bearer ${token.secret}`);

    const res = await GET(req, { params: Promise.resolve({ slug }) });

    expect(res.status).toBe(200);

    const body = await res.json();

    // Enabled-only, EXACT shape (no extra keys, no enabled/provider leak).
    expect(body).toEqual({
      runners: [
        {
          id: enabledId,
          adapter: "claude",
          model: "claude-sonnet-4-6",
          capabilityAgent: "claude",
          readinessStatus: "Ready",
        },
      ],
    });

    const auditRows = await db
      .select()
      .from(schema.tokenAuditLog as any)
      .execute();

    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      result: "ok",
      status_code: 200,
      scope_used: "runners:read",
      endpoint: "GET /api/v1/ext/projects/[slug]/runners",
    });
  });

  it("cross-project slug (outside owner access) → 404, existence-hidden", async () => {
    const ownerUserId = await seedUser("runners-hidden");
    const visible = `ext-runners-visible-${randomUUID().slice(0, 8)}`;
    const hidden = `ext-runners-hidden-${randomUUID().slice(0, 8)}`;
    const visibleId = await seedProject(visible);
    const hiddenId = await seedProject(hidden);

    await seedProjectMember(visibleId, ownerUserId);

    const token = await issueToken(
      {
        projectId: null as unknown as string,
        name: "Global Token",
        tokenKind: "user",
        ownerUserId,
        scopes: ["runners:read"],
      },
      db,
    );
    const req = makeRequest(hidden);

    req.headers.set("authorization", `Bearer ${token.secret}`);

    const res = await GET(req, { params: Promise.resolve({ slug: hidden }) });

    expect(res.status).toBe(404);

    const auditRows = await db
      .select()
      .from(schema.tokenAuditLog as any)
      .execute();

    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      result: "error",
      status_code: 404,
      project_id: hiddenId,
      scope_used: "runners:read",
    });
  });
});
