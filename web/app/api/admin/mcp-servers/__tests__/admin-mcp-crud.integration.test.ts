// M27/T-C1 (spec §9 7.2.3/4): platform MCP admin CRUD against a real
// testcontainer postgres — proves the migration, the race-safe duplicate 409,
// and the usage-guarded delete/disable (a platform MCP materialized into a
// project's capability_records cannot be deleted or disabled → 409). Docker-only
// (skipped where the daemon is absent), like the other *.integration.test.ts.
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { type NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import * as schemaModule from "@/lib/db/schema";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const schema = schemaModule as unknown as Record<string, any>;
const { platformMcpServers, projects, capabilityRecords } = schema;

let testDatabase: StartedPostgresTestDb;
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
// Deterministic host reads so the route's readiness recompute is testable
// without a live supervisor. ADR-179 split them in two: `diagnostics()` still
// carries the ADAPTER gate, while PRESENCE now comes from
// `POST /diagnostics/env-refs` — GITHUB_TOKEN present, everything else absent.
// `envRefsFails` lets one case make the presence read throw, which is the
// degrade-to-Unknown path.
let envRefsFails = false;

vi.mock("@/lib/supervisor-client", () => ({
  ENV_REFS_MAX_PER_CALL: 64,
  checkSupervisorDiagnostics: vi.fn(async () => ({
    kind: "ready",
    diagnostics: {
      status: "ready",
      version: "1.0.0",
      checkedAt: "2026-06-13T00:00:00.000Z",
      adapters: [],
      envRefs: [],
    },
  })),
  checkSupervisorEnvRefs: vi.fn(async (names: readonly string[]) => {
    if (envRefsFails) throw new Error("fake host: env-refs unavailable");

    return names.map((name) => ({
      name,
      present: name === "GITHUB_TOKEN",
    }));
  }),
}));

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "mcp_crud_test",
  });
  db = testDatabase.db;
}, 120_000);

afterAll(async () => {
  await testDatabase?.stop();
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

  await db.insert(projects).values({
    taskKey: `T${crypto.randomUUID().slice(0, 8)}`.toUpperCase(),
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
        env: { GITHUB_TOKEN: "env:GITHUB_TOKEN" },
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

  // ADR-179 (D24): the route ACCEPTS a literal — the secret guard is a UI
  // warning, and this is the case that pins the route half of that decision.
  it("ACCEPTS a literal value under a secret-shaped key (201)", async () => {
    const { POST } = await import("../route");
    const res = await POST(
      postRequest({
        id: `lit-${randomUUID().slice(0, 8)}`,
        transport: "stdio",
        command: "x",
        env: { GITHUB_TOKEN: "sk-raw-secret-value" },
      }),
    );

    expect(res.status).toBe(201);
  });

  it("rejects a MALFORMED env: value with 422", async () => {
    const { POST } = await import("../route");
    const res = await POST(
      postRequest({
        id: `bad-${randomUUID().slice(0, 8)}`,
        transport: "stdio",
        command: "x",
        env: { GH: "env:1BAD" },
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

  it("recomputes readiness on every write (POST sets Ready, PATCH flips to NotReady)", async () => {
    const { POST } = await import("../route");
    const { PATCH } = await import("../[id]/route");
    const id = `ready-${randomUUID().slice(0, 8)}`;

    await POST(
      postRequest({
        id,
        transport: "stdio",
        command: "github-mcp",
        env: { GITHUB_TOKEN: "env:GITHUB_TOKEN" },
      }),
    );

    let rows = await db
      .select()
      .from(platformMcpServers)
      .where(eq(platformMcpServers.id, id));

    expect((rows[0] as { readinessStatus: string }).readinessStatus).toBe(
      "Ready",
    );
    expect(
      (rows[0] as { readinessReasons: string[] }).readinessReasons,
    ).toEqual([]);

    await PATCH(patchRequest({ env: { GH: "env:MISSING_TOKEN" } }), {
      params: Promise.resolve({ id }),
    });

    rows = await db
      .select()
      .from(platformMcpServers)
      .where(eq(platformMcpServers.id, id));

    expect((rows[0] as { readinessStatus: string }).readinessStatus).toBe(
      "NotReady",
    );
    expect(
      (rows[0] as { readinessReasons: string[] }).readinessReasons,
    ).toContain("env ref missing: MISSING_TOKEN");
  });

  it("a LITERAL value produces no readiness reason — it references nothing", async () => {
    const { POST } = await import("../route");
    const id = `lit-ready-${randomUUID().slice(0, 8)}`;

    await POST(
      postRequest({
        id,
        transport: "stdio",
        command: "x",
        env: { FASTMCP_LOG_LEVEL: "ERROR", GH_HOST: "github.com" },
      }),
    );

    const [row] = await db
      .select()
      .from(platformMcpServers)
      .where(eq(platformMcpServers.id, id));

    expect((row as { readinessStatus: string }).readinessStatus).toBe("Ready");
  });

  it("degrades to Unknown and still COMMITS when the host env-ref read fails", async () => {
    // The host reads are reads, not side effects: a dead host must not refuse
    // the write. `Unknown` is the honest verdict, not a silent `Ready`.
    const { POST } = await import("../route");
    const id = `unk-${randomUUID().slice(0, 8)}`;

    envRefsFails = true;
    try {
      const res = await POST(
        postRequest({
          id,
          transport: "stdio",
          command: "x",
          env: { GH: "env:GITHUB_TOKEN" },
        }),
      );

      expect(res.status).toBe(201);
    } finally {
      envRefsFails = false;
    }

    const [row] = await db
      .select()
      .from(platformMcpServers)
      .where(eq(platformMcpServers.id, id));

    expect((row as { readinessStatus: string }).readinessStatus).toBe(
      "Unknown",
    );
  });
});
