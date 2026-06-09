// M27/T-C5: project-scoped MCP CRUD against a real testcontainer postgres.
// Project MCPs are `capability_records` rows with source='project', kind='mcp'.
// Proves: create (POST) → list (GET) shows it; PATCH edits the material;
// DELETE removes it; secrets are env:NAME only; and — the security boundary —
// project scoping: a second project's MCP is never returned by the first
// project's GET, and PATCH/DELETE of a foreign mcpId yields 404 (no cross-project
// read/edit). RBAC mirrors the catalog caps route (manageCatalog → admin).
// Docker-only (skipped where the daemon is absent), like the other
// *.integration.test.ts. RED until app/api/projects/[slug]/mcp/route.ts and
// .../mcp/[mcpId]/route.ts exist.
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

// Mutable reference so individual tests can control the session identity.
const sessionRef: { value: unknown } = { value: null };

vi.mock("@/auth", () => ({
  auth: vi.fn(async () => sessionRef.value),
  signIn: vi.fn(),
  signOut: vi.fn(),
  handlers: {},
}));

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

let listRoute: typeof import("@/app/api/projects/[slug]/mcp/route");
let itemRoute: typeof import("@/app/api/projects/[slug]/mcp/[mcpId]/route");

const PROJECT_A_ID = randomUUID();
const PROJECT_A_SLUG = `proj-mcp-${randomUUID()}`;
const PROJECT_B_ID = randomUUID();
const PROJECT_B_SLUG = `proj-mcp-other-${randomUUID()}`;

const ADMIN = { user: { id: "u-admin", role: "admin" } };

function listRequest(slug: string, method: "GET" | "POST", body?: unknown) {
  return new NextRequest(`http://localhost/api/projects/${slug}/mcp`, {
    method,
    ...(body === undefined
      ? {}
      : {
          body: JSON.stringify(body),
          headers: { "content-type": "application/json" },
        }),
  });
}

function itemRequest(
  slug: string,
  mcpId: string,
  method: "GET" | "PATCH" | "DELETE",
  body?: unknown,
) {
  return new NextRequest(`http://localhost/api/projects/${slug}/mcp/${mcpId}`, {
    method,
    ...(body === undefined
      ? {}
      : {
          body: JSON.stringify(body),
          headers: { "content-type": "application/json" },
        }),
  });
}

function listCtx(slug: string) {
  return { params: Promise.resolve({ slug }) };
}

function itemCtx(slug: string, mcpId: string) {
  return { params: Promise.resolve({ slug, mcpId }) };
}

async function createMcp(
  slug: string,
  body: Record<string, unknown>,
): Promise<{ status: number; id?: string }> {
  const res = await listRoute.POST(
    listRequest(slug, "POST", body),
    listCtx(slug),
  );
  const json = (await res.json().catch(() => ({}))) as { id?: string };

  return { status: res.status, id: json.id };
}

async function listMcps(
  slug: string,
): Promise<{ status: number; ids: string[]; refs: string[] }> {
  const res = await listRoute.GET(listRequest(slug, "GET"), listCtx(slug));
  const json = (await res.json().catch(() => ({ servers: [] }))) as {
    servers?: Array<{ id: string; mcpId: string }>;
  };

  return {
    status: res.status,
    ids: (json.servers ?? []).map((s) => s.id),
    refs: (json.servers ?? []).map((s) => s.mcpId),
  };
}

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("project_mcp_test")
    .withUsername("test")
    .withPassword("test")
    .start();

  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);
  await migrate(db, { migrationsFolder: "./lib/db/migrations" });

  await db.insert(schema.projects).values([
    {
      id: PROJECT_A_ID,
      slug: PROJECT_A_SLUG,
      name: PROJECT_A_SLUG,
      repoPath: `/tmp/${PROJECT_A_SLUG}`,
      maisterYamlPath: `/tmp/${PROJECT_A_SLUG}/maister.yaml`,
    },
    {
      id: PROJECT_B_ID,
      slug: PROJECT_B_SLUG,
      name: PROJECT_B_SLUG,
      repoPath: `/tmp/${PROJECT_B_SLUG}`,
      maisterYamlPath: `/tmp/${PROJECT_B_SLUG}/maister.yaml`,
    },
  ]);

  // u-admin    — global admin (bypasses project RBAC).
  // u-viewer   — project viewer on A (readBoard, NOT manageCatalog).
  // u-outside  — no membership at all.
  // u-cap-admin — project admin on A (has manageCatalog).
  await db.insert(schema.users).values([
    {
      id: "u-admin",
      email: "admin@test.com",
      role: "admin",
      passwordHash: "x",
      accountStatus: "active",
    },
    {
      id: "u-viewer",
      email: "viewer@test.com",
      role: "member",
      passwordHash: "x",
      accountStatus: "active",
    },
    {
      id: "u-outside",
      email: "outside@test.com",
      role: "member",
      passwordHash: "x",
      accountStatus: "active",
    },
    {
      id: "u-cap-admin",
      email: "cap-admin@test.com",
      role: "member",
      passwordHash: "x",
      accountStatus: "active",
    },
  ]);

  await db.insert(schema.projectMembers).values([
    {
      id: randomUUID(),
      projectId: PROJECT_A_ID,
      userId: "u-viewer",
      role: "viewer",
    },
    {
      id: randomUUID(),
      projectId: PROJECT_A_ID,
      userId: "u-cap-admin",
      role: "admin",
    },
  ]);

  listRoute = await import("@/app/api/projects/[slug]/mcp/route");
  itemRoute = await import("@/app/api/projects/[slug]/mcp/[mcpId]/route");
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

describe("project MCP CRUD (real postgres)", () => {
  it("creates a stdio MCP, lists it, edits it, and deletes it", async () => {
    sessionRef.value = ADMIN;
    const mcpId = `github-${randomUUID().slice(0, 8)}`;

    const created = await createMcp(PROJECT_A_SLUG, {
      id: mcpId,
      transport: "stdio",
      command: "github-mcp",
      args: ["--stdio"],
      envKeys: ["env:GITHUB_TOKEN"],
    });

    expect(created.status).toBe(201);

    const recordId = created.id;

    expect(typeof recordId).toBe("string");

    const listed = await listMcps(PROJECT_A_SLUG);

    expect(listed.status).toBe(200);
    expect(listed.refs).toContain(mcpId);

    const patched = await itemRoute.PATCH(
      itemRequest(PROJECT_A_SLUG, recordId!, "PATCH", {
        command: "github-mcp-v2",
      }),
      itemCtx(PROJECT_A_SLUG, recordId!),
    );

    expect(patched.status).toBe(200);

    const get = await itemRoute.GET(
      itemRequest(PROJECT_A_SLUG, recordId!, "GET"),
      itemCtx(PROJECT_A_SLUG, recordId!),
    );
    const getBody = (await get.json()) as {
      command?: string;
      enabled?: boolean;
    };

    expect(get.status).toBe(200);
    expect(getBody.command).toBe("github-mcp-v2");
    // An unrelated field edit must not flip enablement.
    expect(getBody.enabled).toBe(true);

    const deleted = await itemRoute.DELETE(
      itemRequest(PROJECT_A_SLUG, recordId!, "DELETE"),
      itemCtx(PROJECT_A_SLUG, recordId!),
    );

    expect(deleted.status).toBe(204);

    const afterDelete = await listMcps(PROJECT_A_SLUG);

    expect(afterDelete.refs).not.toContain(mcpId);
  });

  it("rejects a plaintext secret value (env:NAME only) with 422", async () => {
    sessionRef.value = ADMIN;
    const created = await createMcp(PROJECT_A_SLUG, {
      id: `bad-${randomUUID().slice(0, 8)}`,
      transport: "stdio",
      command: "x",
      envKeys: ["sk-raw-secret-value"],
    });

    expect(created.status).toBe(422);
  });

  it("rejects a duplicate project MCP id with 409", async () => {
    sessionRef.value = ADMIN;
    const mcpId = `dup-${randomUUID().slice(0, 8)}`;
    const body = { id: mcpId, transport: "stdio", command: "run" };

    const first = await createMcp(PROJECT_A_SLUG, body);

    expect(first.status).toBe(201);

    const second = await createMcp(PROJECT_A_SLUG, body);

    expect(second.status).toBe(409);
  });

  it("creates an http MCP with header key refs", async () => {
    sessionRef.value = ADMIN;
    const created = await createMcp(PROJECT_A_SLUG, {
      id: `http-${randomUUID().slice(0, 8)}`,
      transport: "http",
      url: "https://mcp.example.com/sse",
      headerKeys: ["env:MCP_AUTH"],
    });

    expect(created.status).toBe(201);
  });
});

describe("project MCP RBAC (real postgres)", () => {
  it("403 for a project viewer (below manageCatalog)", async () => {
    sessionRef.value = { user: { id: "u-viewer", role: "member" } };

    const res = await listRoute.POST(
      listRequest(PROJECT_A_SLUG, "POST", {
        id: `v-${randomUUID().slice(0, 8)}`,
        transport: "stdio",
        command: "run",
      }),
      listCtx(PROJECT_A_SLUG),
    );

    expect(res.status).toBe(403);
  });

  it("201 for a project admin (manageCatalog)", async () => {
    sessionRef.value = { user: { id: "u-cap-admin", role: "member" } };

    const res = await listRoute.POST(
      listRequest(PROJECT_A_SLUG, "POST", {
        id: `ok-${randomUUID().slice(0, 8)}`,
        transport: "stdio",
        command: "run",
      }),
      listCtx(PROJECT_A_SLUG),
    );

    expect(res.status).toBe(201);
  });

  it("403 for a user with no project membership", async () => {
    sessionRef.value = { user: { id: "u-outside", role: "member" } };

    const res = await listRoute.GET(
      listRequest(PROJECT_A_SLUG, "GET"),
      listCtx(PROJECT_A_SLUG),
    );

    expect(res.status).toBe(403);
  });
});

describe("project MCP project scoping (real postgres)", () => {
  it("isolates MCPs per project and 404s cross-project mutations", async () => {
    sessionRef.value = ADMIN;

    // One MCP in each project, same human id to prove isolation is by row id.
    const sharedRef = `iso-${randomUUID().slice(0, 8)}`;
    const inA = await createMcp(PROJECT_A_SLUG, {
      id: sharedRef,
      transport: "stdio",
      command: "a-cmd",
    });
    const inB = await createMcp(PROJECT_B_SLUG, {
      id: sharedRef,
      transport: "stdio",
      command: "b-cmd",
    });

    expect(inA.status).toBe(201);
    expect(inB.status).toBe(201);

    const recordInB = inB.id!;

    // Project A's list must NOT contain project B's row id.
    const listA = await listMcps(PROJECT_A_SLUG);

    expect(listA.ids).toContain(inA.id);
    expect(listA.ids).not.toContain(recordInB);

    // GET of B's record under A's slug → 404.
    const crossGet = await itemRoute.GET(
      itemRequest(PROJECT_A_SLUG, recordInB, "GET"),
      itemCtx(PROJECT_A_SLUG, recordInB),
    );

    expect(crossGet.status).toBe(404);

    // PATCH of B's record under A's slug → 404, and B's row is untouched.
    const crossPatch = await itemRoute.PATCH(
      itemRequest(PROJECT_A_SLUG, recordInB, "PATCH", { command: "hijacked" }),
      itemCtx(PROJECT_A_SLUG, recordInB),
    );

    expect(crossPatch.status).toBe(404);

    // DELETE of B's record under A's slug → 404, and B's row survives.
    const crossDelete = await itemRoute.DELETE(
      itemRequest(PROJECT_A_SLUG, recordInB, "DELETE"),
      itemCtx(PROJECT_A_SLUG, recordInB),
    );

    expect(crossDelete.status).toBe(404);

    // B's record, fetched under B's slug, is intact and unmodified.
    const ownGet = await itemRoute.GET(
      itemRequest(PROJECT_B_SLUG, recordInB, "GET"),
      itemCtx(PROJECT_B_SLUG, recordInB),
    );
    const ownBody = (await ownGet.json()) as { command?: string };

    expect(ownGet.status).toBe(200);
    expect(ownBody.command).toBe("b-cmd");
  });
});
