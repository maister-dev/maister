// M27/T-C1 (spec §9 7.2.3/4): platform MCP admin CRUD against a real
// testcontainer postgres — proves the migration, the race-safe duplicate 409,
// and the usage-guarded delete/disable (a platform MCP materialized into a
// project's capability_records cannot be deleted or disabled → 409). Docker-only
// (skipped where the daemon is absent), like the other *.integration.test.ts.
import { randomUUID } from "node:crypto";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { type NextRequest } from "next/server";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import * as schemaModule from "@/lib/db/schema";

const schema = schemaModule as unknown as Record<string, any>;
const { platformMcpServers, projects, capabilityRecords } = schema;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;

// The route's getDb() resolves to the test container db, so there is exactly
// one pool (closed in afterAll) and no lingering connection at teardown.
vi.mock("@/lib/db/client", () => ({ getDb: () => db }));
vi.mock("@/lib/authz", () => ({
  requireGlobalRole: vi.fn(async () => ({
    id: "usr_bootstrap_admin",
    role: "admin",
    mustChangePassword: false,
  })),
}));

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("mcp_crud_test")
    .withUsername("test")
    .withPassword("test")
    .start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);
  await migrate(db, { migrationsFolder: "./lib/db/migrations" });
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

function postRequest(body: unknown): NextRequest {
  return new Request("http://x/api/admin/mcp-servers", {
    method: "POST",
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

function patchRequest(body: unknown): NextRequest {
  return new Request("http://x", {
    method: "PATCH",
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

function deleteRequest(): NextRequest {
  return new Request("http://x", {
    method: "DELETE",
  }) as unknown as NextRequest;
}

async function seedMaterialization(mcpId: string): Promise<string> {
  const projectId = `prj_${randomUUID().slice(0, 8)}`;

  await db.insert(projects).values({ taskKey: `T${crypto.randomUUID().slice(0, 8)}`.toUpperCase(),
    id: projectId,
    slug: `slug-${randomUUID().slice(0, 8)}`,
    name: "ref project",
    repoPath: `/repos/${randomUUID().slice(0, 8)}`,
    maisterYamlPath: "/repos/x/maister.yaml",
  });
  await db.insert(capabilityRecords).values({
    id: `cap_${randomUUID().slice(0, 8)}`,
    projectId,
    capabilityRefId: mcpId,
    kind: "mcp",
    label: mcpId,
    source: "platform",
    agents: {},
  });

  return projectId;
}

describe("admin MCP server CRUD (real postgres)", () => {
  it("creates a stdio server, lists it, and rejects a duplicate id with 409", async () => {
    const { GET, POST } = await import("../route");
    const id = `github-${randomUUID().slice(0, 8)}`;

    const created = await POST(
      postRequest({
        id,
        transport: "stdio",
        command: "github-mcp",
        envKeys: ["env:GITHUB_TOKEN"],
      }),
    );

    expect(created.status).toBe(201);

    const list = await GET();
    const body = (await list.json()) as { servers: Array<{ id: string }> };

    expect(list.status).toBe(200);
    expect(body.servers.map((s) => s.id)).toContain(id);

    const dup = await POST(
      postRequest({ id, transport: "stdio", command: "github-mcp" }),
    );
    const dupBody = (await dup.json()) as { code?: string };

    expect(dup.status).toBe(409);
    expect(dupBody.code).toBe("CONFLICT");
  });

  it("rejects a plaintext secret value (env:NAME only) with 422", async () => {
    const { POST } = await import("../route");
    const res = await POST(
      postRequest({
        id: `bad-${randomUUID().slice(0, 8)}`,
        transport: "stdio",
        command: "x",
        envKeys: ["sk-raw-secret-value"],
      }),
    );
    const body = (await res.json()) as { code?: string };

    expect(res.status).toBe(422);
    expect(body.code).toBe("CONFIG");
  });

  it("returns 404 for PATCH/DELETE of an unknown id", async () => {
    const { PATCH, DELETE } = await import("../[id]/route");

    const patched = await PATCH(patchRequest({ enabled: false }), {
      params: Promise.resolve({ id: "does-not-exist" }),
    });

    expect(patched.status).toBe(404);

    const deleted = await DELETE(deleteRequest(), {
      params: Promise.resolve({ id: "does-not-exist" }),
    });

    expect(deleted.status).toBe(404);
  });

  it("patches and deletes an unreferenced server", async () => {
    const { POST } = await import("../route");
    const { PATCH, DELETE } = await import("../[id]/route");
    const id = `solo-${randomUUID().slice(0, 8)}`;

    await POST(postRequest({ id, transport: "stdio", command: "run" }));

    const patched = await PATCH(patchRequest({ enabled: false }), {
      params: Promise.resolve({ id }),
    });

    expect(patched.status).toBe(200);

    const deleted = await DELETE(deleteRequest(), {
      params: Promise.resolve({ id }),
    });

    expect(deleted.status).toBe(204);

    const rows = await db
      .select()
      .from(platformMcpServers)
      .where(eq(platformMcpServers.id, id));

    expect(rows).toHaveLength(0);
  });

  it("refuses to delete or disable a server referenced by a project materialization (409)", async () => {
    const { POST } = await import("../route");
    const { PATCH, DELETE } = await import("../[id]/route");
    const id = `pinned-${randomUUID().slice(0, 8)}`;

    await POST(postRequest({ id, transport: "stdio", command: "run" }));
    await seedMaterialization(id);

    const deleted = await DELETE(deleteRequest(), {
      params: Promise.resolve({ id }),
    });
    const deletedBody = (await deleted.json()) as { code?: string };

    expect(deleted.status).toBe(409);
    expect(deletedBody.code).toBe("CONFLICT");

    const disabled = await PATCH(patchRequest({ enabled: false }), {
      params: Promise.resolve({ id }),
    });
    const disabledBody = (await disabled.json()) as { code?: string };

    expect(disabled.status).toBe(409);
    expect(disabledBody.code).toBe("CONFLICT");

    // The row survives the blocked mutations.
    const rows = await db
      .select()
      .from(platformMcpServers)
      .where(eq(platformMcpServers.id, id));

    expect(rows).toHaveLength(1);
    expect((rows[0] as { enabled: boolean }).enabled).toBe(true);
  });
});
