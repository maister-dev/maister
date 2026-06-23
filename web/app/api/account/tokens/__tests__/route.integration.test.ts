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

let accountGet: any;
let accountPost: any;
let accountDelete: any;
let projectTokensGet: any;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("account_tokens_route_test")
    .withUsername("test")
    .withPassword("test")
    .start();

  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);

  await migrate(db, { migrationsFolder: "./lib/db/migrations" });

  const accountRoute = await import("@/app/api/account/tokens/route");
  const accountTokenRoute = await import(
    "@/app/api/account/tokens/[tokenId]/route"
  );
  const projectTokensRoute = await import(
    "@/app/api/projects/[slug]/tokens/route"
  );

  accountGet = accountRoute.GET;
  accountPost = accountRoute.POST;
  accountDelete = accountTokenRoute.DELETE;
  projectTokensGet = projectTokensRoute.GET;
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

function asSession(userId: string): void {
  sessionRef.value = { user: { id: userId } };
}

function clearSession(): void {
  sessionRef.value = null;
}

function accountRequest(method: string, body?: unknown): NextRequest {
  return new NextRequest("http://localhost/api/account/tokens", {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function deleteRequest(tokenId: string): NextRequest {
  return new NextRequest(`http://localhost/api/account/tokens/${tokenId}`, {
    method: "DELETE",
  });
}

async function seedUser(input?: {
  accountStatus?: "active" | "pending" | "disabled";
  mustChangePassword?: boolean;
}): Promise<string> {
  const userId = randomUUID();

  await db.insert(schema.users).values({
    id: userId,
    name: `User ${userId.slice(0, 8)}`,
    email: `user-${userId.slice(0, 8)}@example.test`,
    role: "member",
    accountStatus: input?.accountStatus ?? "active",
    mustChangePassword: input?.mustChangePassword ?? false,
    passwordHash: "x",
  });

  return userId;
}

async function seedProjectForUser(userId: string): Promise<{
  projectId: string;
  slug: string;
}> {
  const projectId = randomUUID();
  const slug = `acct-tok-${projectId.slice(0, 8)}`;

  await db.insert(schema.projects).values({
    id: projectId,
    taskKey: `T${randomUUID().slice(0, 8)}`.toUpperCase(),
    slug,
    name: `Project ${slug}`,
    repoPath: `/tmp/${slug}`,
    maisterYamlPath: `/tmp/${slug}/maister.yaml`,
  });
  await db.insert(schema.projectMembers).values({
    projectId,
    userId,
    role: "admin",
  });

  return { projectId, slug };
}

async function tokenRow(tokenId: string): Promise<Record<string, any>> {
  const rows = await db
    .select()
    .from(schema.projectTokens)
    .where(eq(schema.projectTokens.id, tokenId))
    .limit(1);

  expect(rows).toHaveLength(1);

  return rows[0] as Record<string, any>;
}

describe("account personal API token routes", () => {
  it("creates a global personal token and lists it without reusable secret material", async () => {
    const userId = await seedUser();

    asSession(userId);

    const createRes = await accountPost(
      accountRequest("POST", {
        name: "Personal agent",
        scopes: ["tasks:read", "hitl:inbox:read"],
        humanHitl: false,
        expiresAt: null,
      }),
    );

    expect(createRes.status).toBe(201);

    const created = await createRes.json();

    expect(created).toMatchObject({
      name: "Personal agent",
      kind: "user",
      ownerUserId: userId,
      scopes: ["tasks:read", "hitl:inbox:read"],
      humanHitl: false,
    });
    expect(created.token).toMatch(/^mai_/);
    expect(created.prefix).toBe(created.token.slice(0, 12));

    const row = await tokenRow(created.id);

    expect(row.project_id).toBeNull();
    expect(row.owner_user_id).toBe(userId);
    expect(row.token_hash).not.toBe(created.token);

    const listRes = await accountGet(accountRequest("GET"));

    expect(listRes.status).toBe(200);

    const listedBody = await listRes.json();
    const listed = listedBody.tokens.find(
      (item: { id: string }) => item.id === created.id,
    );

    expect(listed).toMatchObject({
      id: created.id,
      prefix: created.prefix,
      humanHitl: false,
    });
    expect(listed).not.toHaveProperty("token");
    expect(listed).not.toHaveProperty("token_hash");

    clearSession();
  });

  it("normalizes humanHitl into the exact human scope without accepting raw human scope", async () => {
    const userId = await seedUser();

    asSession(userId);

    const rawScopeRes = await accountPost(
      accountRequest("POST", {
        name: "Bad human scope",
        scopes: ["hitl:respond:human"],
        humanHitl: false,
      }),
    );

    expect(rawScopeRes.status).toBe(422);

    const createRes = await accountPost(
      accountRequest("POST", {
        name: "Human responder",
        scopes: ["*"],
        humanHitl: true,
      }),
    );

    expect(createRes.status).toBe(201);

    const created = await createRes.json();

    expect(created.humanHitl).toBe(true);
    expect(created.scopes).toEqual(["*", "hitl:respond:human"]);

    clearSession();
  });

  it("revokes only the current owner's global personal token", async () => {
    const ownerId = await seedUser();
    const otherUserId = await seedUser();

    asSession(ownerId);

    const createRes = await accountPost(
      accountRequest("POST", { name: "Owner token" }),
    );
    const created = await createRes.json();

    asSession(otherUserId);

    const otherDeleteRes = await accountDelete(deleteRequest(created.id), {
      params: Promise.resolve({ tokenId: created.id }),
    });

    expect(otherDeleteRes.status).toBe(404);

    asSession(ownerId);

    const deleteRes = await accountDelete(deleteRequest(created.id), {
      params: Promise.resolve({ tokenId: created.id }),
    });
    const secondDeleteRes = await accountDelete(deleteRequest(created.id), {
      params: Promise.resolve({ tokenId: created.id }),
    });

    expect(deleteRes.status).toBe(204);
    expect(secondDeleteRes.status).toBe(204);

    clearSession();
  });

  it("keeps global personal tokens out of project token lists", async () => {
    const userId = await seedUser();
    const { slug } = await seedProjectForUser(userId);

    asSession(userId);

    const createRes = await accountPost(
      accountRequest("POST", { name: "Global token" }),
    );
    const created = await createRes.json();

    const projectListRes = await projectTokensGet(
      new NextRequest(`http://localhost/api/projects/${slug}/tokens`, {
        method: "GET",
      }),
      { params: Promise.resolve({ slug }) },
    );

    expect(projectListRes.status).toBe(200);

    const body = await projectListRes.json();

    expect(
      body.tokens.some((item: { id: string }) => item.id === created.id),
    ).toBe(false);

    clearSession();
  });

  it("rejects inactive and password-change-required accounts before token work", async () => {
    const inactiveUserId = await seedUser({ accountStatus: "disabled" });
    const passwordChangeUserId = await seedUser({ mustChangePassword: true });

    asSession(inactiveUserId);

    const inactiveRes = await accountPost(
      accountRequest("POST", { name: "Blocked" }),
    );

    expect(inactiveRes.status).toBe(403);

    asSession(passwordChangeUserId);

    const passwordChangeRes = await accountGet(accountRequest("GET"));

    expect(passwordChangeRes.status).toBe(403);

    clearSession();
  });
});
