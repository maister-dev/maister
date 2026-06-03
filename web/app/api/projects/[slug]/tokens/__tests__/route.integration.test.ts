import { randomUUID } from "node:crypto";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { NextRequest } from "next/server";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import * as schemaModule from "@/lib/db/schema";

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

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("tokens_route_test")
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

let POST: typeof import("@/app/api/projects/[slug]/tokens/route").POST;
let GET: typeof import("@/app/api/projects/[slug]/tokens/route").GET;
let DELETE_handler: typeof import("@/app/api/projects/[slug]/tokens/[tokenId]/route").DELETE;

beforeAll(async () => {
  const routeModule = await import("@/app/api/projects/[slug]/tokens/route");
  const tokenIdRouteModule = await import(
    "@/app/api/projects/[slug]/tokens/[tokenId]/route"
  );

  POST = routeModule.POST;
  GET = routeModule.GET;
  DELETE_handler = tokenIdRouteModule.DELETE;
});

async function seedProject(slug: string) {
  const projectId = randomUUID();
  const adminId = randomUUID();
  const memberId = randomUUID();

  await db.insert(schema.projects).values({
    id: projectId,
    slug,
    name: `Project ${slug}`,
    repoPath: `/tmp/${slug}`,
    maisterYamlPath: `/tmp/${slug}/maister.yaml`,
  });

  await db.insert(schema.users).values([
    {
      id: adminId,
      email: `admin-${slug}@example.com`,
      role: "admin",
      accountStatus: "active",
      passwordHash: "x",
    },
    {
      id: memberId,
      email: `member-${slug}@example.com`,
      role: "member",
      accountStatus: "active",
      passwordHash: "x",
    },
  ]);

  await db.insert(schema.projectMembers).values([
    { projectId, userId: adminId, role: "admin" },
    { projectId, userId: memberId, role: "member" },
  ]);

  return { projectId, adminId, memberId };
}

function asAdminSession(userId: string) {
  sessionRef.value = { user: { id: userId } };
}

function asMemberSession(userId: string) {
  sessionRef.value = { user: { id: userId } };
}

function clearSession() {
  sessionRef.value = null;
}

function makeRequest(body?: unknown): NextRequest {
  return new NextRequest("http://localhost/api/projects/test/tokens", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

describe("POST /api/projects/[slug]/tokens", () => {
  it("admin → 201 with plaintext token exactly once and matching prefix", async () => {
    const { slug } = { slug: `tok-post-${randomUUID().slice(0, 8)}` };
    const { adminId } = await seedProject(slug);

    asAdminSession(adminId);

    const req = makeRequest({ name: "CI Token" });
    const res = await POST(req, {
      params: Promise.resolve({ slug }),
    });

    expect(res.status).toBe(201);

    const body = await res.json();

    expect(body).toHaveProperty("token");
    expect(body).toHaveProperty("prefix");
    expect(typeof body.token).toBe("string");
    expect(body.token).toMatch(/^mai_/);
    expect(body.prefix).toBe(body.token.slice(0, 12));
    expect(body).toHaveProperty("id");
    expect(body).toHaveProperty("name", "CI Token");

    clearSession();
  });

  it("member → 403 (editSettings requires admin)", async () => {
    const { slug } = { slug: `tok-member-${randomUUID().slice(0, 8)}` };
    const { memberId } = await seedProject(slug);

    asMemberSession(memberId);

    const req = makeRequest({ name: "CI Token" });
    const res = await POST(req, {
      params: Promise.resolve({ slug }),
    });

    expect(res.status).toBe(403);

    clearSession();
  });
});

describe("GET /api/projects/[slug]/tokens", () => {
  it("returns 200 with token list, no hash or secret", async () => {
    const { slug } = { slug: `tok-get-${randomUUID().slice(0, 8)}` };
    const { adminId } = await seedProject(slug);

    asAdminSession(adminId);

    // Create a token first
    const createReq = makeRequest({ name: "List Token" });

    await POST(createReq, { params: Promise.resolve({ slug }) });

    const listReq = new NextRequest(
      `http://localhost/api/projects/${slug}/tokens`,
      { method: "GET" },
    );
    const res = await GET(listReq, {
      params: Promise.resolve({ slug }),
    });

    expect(res.status).toBe(200);

    const body = await res.json();

    expect(Array.isArray(body.tokens)).toBe(true);
    expect(body.tokens.length).toBeGreaterThanOrEqual(1);

    for (const item of body.tokens) {
      expect(item).not.toHaveProperty("token");
      expect(item).not.toHaveProperty("token_hash");
      expect((item as any).token).toBeUndefined();
      expect((item as any).token_hash).toBeUndefined();
    }

    clearSession();
  });
});

describe("DELETE /api/projects/[slug]/tokens/[tokenId]", () => {
  it("revoke own token → 204", async () => {
    const { slug } = { slug: `tok-del-${randomUUID().slice(0, 8)}` };
    const { adminId } = await seedProject(slug);

    asAdminSession(adminId);

    const createRes = await POST(makeRequest({ name: "Delete Me" }), {
      params: Promise.resolve({ slug }),
    });
    const { id: tokenId } = await createRes.json();

    const delReq = new NextRequest(
      `http://localhost/api/projects/${slug}/tokens/${tokenId}`,
      { method: "DELETE" },
    );
    const res = await DELETE_handler(delReq, {
      params: Promise.resolve({ slug, tokenId }),
    });

    expect(res.status).toBe(204);

    clearSession();
  });

  it("cross-project tokenId → 404 (existence-hide)", async () => {
    const { slug: slug1 } = { slug: `tok-cross1-${randomUUID().slice(0, 8)}` };
    const { slug: slug2 } = { slug: `tok-cross2-${randomUUID().slice(0, 8)}` };
    const { adminId: adminId1 } = await seedProject(slug1);
    const { adminId: adminId2 } = await seedProject(slug2);

    // Create a token in project 1
    asAdminSession(adminId1);
    const createRes = await POST(makeRequest({ name: "Project 1 Token" }), {
      params: Promise.resolve({ slug: slug1 }),
    });
    const { id: tokenId } = await createRes.json();

    // Try to delete it from project 2
    asAdminSession(adminId2);
    const delReq = new NextRequest(
      `http://localhost/api/projects/${slug2}/tokens/${tokenId}`,
      { method: "DELETE" },
    );
    const res = await DELETE_handler(delReq, {
      params: Promise.resolve({ slug: slug2, tokenId }),
    });

    expect(res.status).toBe(404);

    clearSession();
  });

  it("non-admin member → 403", async () => {
    const { slug } = { slug: `tok-authz-${randomUUID().slice(0, 8)}` };
    const { adminId, memberId } = await seedProject(slug);

    // Admin creates a token
    asAdminSession(adminId);
    const createRes = await POST(makeRequest({ name: "Auth Test Token" }), {
      params: Promise.resolve({ slug }),
    });
    const { id: tokenId } = await createRes.json();

    // Member tries to delete
    asMemberSession(memberId);
    const delReq = new NextRequest(
      `http://localhost/api/projects/${slug}/tokens/${tokenId}`,
      { method: "DELETE" },
    );
    const res = await DELETE_handler(delReq, {
      params: Promise.resolve({ slug, tokenId }),
    });

    expect(res.status).toBe(403);

    clearSession();
  });
});
