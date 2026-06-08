// RED test: the route at
//   web/app/api/projects/[slug]/catalog/caps/[capId]/graph/route.ts
// does not exist yet. This file will fail with "Cannot find module" until
// T-A1 is implemented.
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

import { createAuthoredCapability } from "@/lib/catalog/authored-service";
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

// Imported after the DB mock is in place.
let GET: typeof import("@/app/api/projects/[slug]/catalog/caps/[capId]/graph/route").GET;

// Stable IDs used across cases.
const PROJECT_A_ID = randomUUID();
const PROJECT_A_SLUG = `proj-graph-${randomUUID()}`;
const PROJECT_B_ID = randomUUID();
const PROJECT_B_SLUG = `proj-graph-other-${randomUUID()}`;

// A small graph-form FlowYamlV1 manifest stored as the authored draft.
const FLOW_MANIFEST = {
  schemaVersion: 1,
  name: "test-flow",
  compat: { engine_min: "1.2.0" },
  nodes: [
    {
      id: "work",
      type: "ai_coding",
      action: { prompt: "/aif-implement" },
      transitions: { success: "done" },
    },
  ],
};

let capIdInProjectA: string;
let capIdInProjectB: string;

function makeRequest(slug: string, capId: string): NextRequest {
  return new NextRequest(
    `http://localhost/api/projects/${slug}/catalog/caps/${capId}/graph`,
    { method: "GET" },
  );
}

function params(slug: string, capId: string) {
  return { params: Promise.resolve({ slug, capId }) };
}

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("graph_route_test")
    .withUsername("test")
    .withPassword("test")
    .start();

  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);
  await migrate(db, { migrationsFolder: "./lib/db/migrations" });

  // Seed two projects.
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

  // Users:
  // u-admin   — global admin (bypasses project RBAC via admin shortcut in authz.ts)
  // u-viewer  — project viewer on PROJECT_A (readBoard, NOT manageCatalog)
  // u-outside — no project membership at all
  // u-admin-cap — project-level admin on PROJECT_A (has manageCatalog)
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

  // Project memberships.
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

  // Seed authored flow cap in PROJECT_A.
  const resultA = await createAuthoredCapability({
    projectSlug: PROJECT_A_SLUG,
    input: {
      kind: "flow",
      slug: "test-flow",
      title: "Test Flow",
      manifest: FLOW_MANIFEST,
    },
    db,
  });

  capIdInProjectA = resultA.capability.id;

  // Seed authored flow cap in PROJECT_B (for the cross-project 404 case).
  const resultB = await createAuthoredCapability({
    projectSlug: PROJECT_B_SLUG,
    input: {
      kind: "flow",
      slug: "other-flow",
      title: "Other Flow",
      manifest: FLOW_MANIFEST,
    },
    db,
  });

  capIdInProjectB = resultB.capability.id;

  ({ GET } = await import(
    "@/app/api/projects/[slug]/catalog/caps/[capId]/graph/route"
  ));
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

describe("GET /api/projects/[slug]/catalog/caps/[capId]/graph — RBAC (integration)", () => {
  it("returns 200 + graph DTO for a global admin", async () => {
    sessionRef.value = { user: { id: "u-admin", role: "admin" } };

    const res = await GET(
      makeRequest(PROJECT_A_SLUG, capIdInProjectA),
      params(PROJECT_A_SLUG, capIdInProjectA),
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.kind).toBe("flow");
    expect(body.draftVersion).toBeGreaterThanOrEqual(1);
    expect(body.topology).toBeDefined();
    expect(Array.isArray(body.topology.nodes)).toBe(true);
    expect(Array.isArray(body.topology.edges)).toBe(true);
    expect(typeof body.layout).toBe("object");
  });

  it("returns 200 + graph DTO for a project-level admin (manageCatalog)", async () => {
    sessionRef.value = { user: { id: "u-cap-admin", role: "member" } };

    const res = await GET(
      makeRequest(PROJECT_A_SLUG, capIdInProjectA),
      params(PROJECT_A_SLUG, capIdInProjectA),
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.kind).toBe("flow");
  });

  it("returns 403 for a project viewer (below manageCatalog threshold)", async () => {
    // viewer has readBoard access but NOT manageCatalog (requires admin).
    sessionRef.value = { user: { id: "u-viewer", role: "member" } };

    const res = await GET(
      makeRequest(PROJECT_A_SLUG, capIdInProjectA),
      params(PROJECT_A_SLUG, capIdInProjectA),
    );

    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("UNAUTHORIZED");
  });

  it("returns 403 for a user with no project membership", async () => {
    sessionRef.value = { user: { id: "u-outside", role: "member" } };

    const res = await GET(
      makeRequest(PROJECT_A_SLUG, capIdInProjectA),
      params(PROJECT_A_SLUG, capIdInProjectA),
    );

    expect(res.status).toBe(403);
  });

  it("returns 404 when capId belongs to a different project", async () => {
    // capIdInProjectB lives under PROJECT_B; asking for it via PROJECT_A slug
    // must yield 404 (assertion: cap ∈ slug).
    sessionRef.value = { user: { id: "u-admin", role: "admin" } };

    const res = await GET(
      makeRequest(PROJECT_A_SLUG, capIdInProjectB),
      params(PROJECT_A_SLUG, capIdInProjectB),
    );

    expect(res.status).toBe(404);
  });

  it("returns 404 for a completely unknown capId", async () => {
    sessionRef.value = { user: { id: "u-admin", role: "admin" } };
    const unknownCapId = randomUUID();

    const res = await GET(
      makeRequest(PROJECT_A_SLUG, unknownCapId),
      params(PROJECT_A_SLUG, unknownCapId),
    );

    expect(res.status).toBe(404);
  });
});

describe("GET /api/projects/[slug]/catalog/caps/[capId]/graph — DTO shape (integration)", () => {
  it("topology.nodes carries the compiled node for each manifest node", async () => {
    sessionRef.value = { user: { id: "u-admin", role: "admin" } };

    const res = await GET(
      makeRequest(PROJECT_A_SLUG, capIdInProjectA),
      params(PROJECT_A_SLUG, capIdInProjectA),
    );
    const body = await res.json();

    expect(res.status).toBe(200);

    const nodeIds: string[] = body.topology.nodes.map(
      (n: { id: string }) => n.id,
    );

    expect(nodeIds).toContain("work");
  });

  it("topology.edges omits the terminal 'done' transition", async () => {
    sessionRef.value = { user: { id: "u-admin", role: "admin" } };

    const res = await GET(
      makeRequest(PROJECT_A_SLUG, capIdInProjectA),
      params(PROJECT_A_SLUG, capIdInProjectA),
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(
      body.topology.edges.every((e: { target: string }) => e.target !== "done"),
    ).toBe(true);
  });
});
