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

let PATCH: typeof import("@/app/api/projects/[slug]/flows/[flowId]/version-binding/route").PATCH;

const PROJECT_ID = randomUUID();
const PROJECT_SLUG = `proj-vbind-${randomUUID()}`;

// A flow row that lives in PROJECT_ID.
let flowId: string;

// A flow row that lives in a DIFFERENT project (for the cross-project 404 case).
const OTHER_PROJECT_ID = randomUUID();
const OTHER_PROJECT_SLUG = `proj-vbind-other-${randomUUID()}`;
let otherFlowId: string;

function makeRequest(slug: string, fId: string, body: unknown): NextRequest {
  return new NextRequest(
    `http://localhost/api/projects/${slug}/flows/${fId}/version-binding`,
    {
      method: "PATCH",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    },
  );
}

function params(slug: string, fId: string) {
  return { params: Promise.resolve({ slug, flowId: fId }) };
}

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("vbind_route_test")
    .withUsername("test")
    .withPassword("test")
    .start();

  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);
  await migrate(db, { migrationsFolder: "./lib/db/migrations" });

  // Seed two projects.
  await db.insert(schema.projects).values([
    { taskKey: `T${crypto.randomUUID().slice(0, 8)}`.toUpperCase(),
      id: PROJECT_ID,
      slug: PROJECT_SLUG,
      name: PROJECT_SLUG,
      repoPath: `/tmp/${PROJECT_SLUG}`,
      maisterYamlPath: `/tmp/${PROJECT_SLUG}/maister.yaml`,
    },
    { taskKey: `T${crypto.randomUUID().slice(0, 8)}`.toUpperCase(),
      id: OTHER_PROJECT_ID,
      slug: OTHER_PROJECT_SLUG,
      name: OTHER_PROJECT_SLUG,
      repoPath: `/tmp/${OTHER_PROJECT_SLUG}`,
      maisterYamlPath: `/tmp/${OTHER_PROJECT_SLUG}/maister.yaml`,
    },
  ]);

  // Users:
  // u-admin   — global admin (bypasses project RBAC)
  // u-member  — project member on PROJECT_ID (launchRun, NOT managePackages)
  // u-pkg-admin — project admin on PROJECT_ID (has managePackages)
  await db.insert(schema.users).values([
    {
      id: "u-admin",
      email: "admin@vbind.test",
      role: "admin",
      passwordHash: "x",
      accountStatus: "active",
    },
    {
      id: "u-member",
      email: "member@vbind.test",
      role: "member",
      passwordHash: "x",
      accountStatus: "active",
    },
    {
      id: "u-pkg-admin",
      email: "pkgadmin@vbind.test",
      role: "member",
      passwordHash: "x",
      accountStatus: "active",
    },
  ]);

  await db.insert(schema.projectMembers).values([
    {
      id: randomUUID(),
      projectId: PROJECT_ID,
      userId: "u-member",
      role: "member",
    },
    {
      id: randomUUID(),
      projectId: PROJECT_ID,
      userId: "u-pkg-admin",
      role: "admin",
    },
  ]);

  // Seed a flows row in PROJECT_ID.
  flowId = randomUUID();

  await db.insert(schema.flows).values({
    id: flowId,
    projectId: PROJECT_ID,
    flowRefId: "bugfix",
    source: "github.com/org/maister-flow-bugfix",
    version: "v1.0.0",
    revision: "abc123",
    installedPath: `/tmp/flows/bugfix@abc123`,
    manifest: { schemaVersion: 1, name: "Bugfix", steps: [] },
    schemaVersion: 1,
  });

  // Seed a flows row in OTHER_PROJECT_ID (for cross-project 404).
  otherFlowId = randomUUID();

  await db.insert(schema.flows).values({
    id: otherFlowId,
    projectId: OTHER_PROJECT_ID,
    flowRefId: "spec-kit",
    source: "github.com/org/maister-flow-spec-kit",
    version: "v0.4.1",
    revision: "def456",
    installedPath: `/tmp/flows/spec-kit@def456`,
    manifest: { schemaVersion: 1, name: "Spec Kit", steps: [] },
    schemaVersion: 1,
  });

  ({ PATCH } = await import(
    "@/app/api/projects/[slug]/flows/[flowId]/version-binding/route"
  ));
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

describe("PATCH /api/projects/[slug]/flows/[flowId]/version-binding — column default (integration)", () => {
  it("freshly-seeded flow has version_binding='latest' (migration default)", async () => {
    // Use raw query to assert the column default from the migrated schema.
    const result = await pool.query(
      "SELECT version_binding FROM flows WHERE id = $1",
      [flowId],
    );

    expect(result.rows[0].version_binding).toBe("latest");
  });
});

describe("PATCH /api/projects/[slug]/flows/[flowId]/version-binding — config-state symmetry (integration)", () => {
  it("PATCH pinned → row is pinned", async () => {
    sessionRef.value = { user: { id: "u-admin", role: "admin" } };

    const res = await PATCH(
      makeRequest(PROJECT_SLUG, flowId, { binding: "pinned" }),
      params(PROJECT_SLUG, flowId),
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.versionBinding).toBe("pinned");

    const result = await pool.query(
      "SELECT version_binding FROM flows WHERE id = $1",
      [flowId],
    );

    expect(result.rows[0].version_binding).toBe("pinned");
  });

  it("PATCH latest → row is latest", async () => {
    sessionRef.value = { user: { id: "u-admin", role: "admin" } };

    const res = await PATCH(
      makeRequest(PROJECT_SLUG, flowId, { binding: "latest" }),
      params(PROJECT_SLUG, flowId),
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.versionBinding).toBe("latest");

    const result = await pool.query(
      "SELECT version_binding FROM flows WHERE id = $1",
      [flowId],
    );

    expect(result.rows[0].version_binding).toBe("latest");
  });

  it("PATCH pinned again → row is pinned (latest→pinned round-trip)", async () => {
    sessionRef.value = { user: { id: "u-admin", role: "admin" } };

    const res = await PATCH(
      makeRequest(PROJECT_SLUG, flowId, { binding: "pinned" }),
      params(PROJECT_SLUG, flowId),
    );

    expect(res.status).toBe(200);

    const result = await pool.query(
      "SELECT version_binding FROM flows WHERE id = $1",
      [flowId],
    );

    expect(result.rows[0].version_binding).toBe("pinned");
  });
});

describe("PATCH /api/projects/[slug]/flows/[flowId]/version-binding — error cases (integration)", () => {
  it("returns 422 for a bad enum value in body", async () => {
    sessionRef.value = { user: { id: "u-admin", role: "admin" } };

    const res = await PATCH(
      makeRequest(PROJECT_SLUG, flowId, { binding: "nightly" }),
      params(PROJECT_SLUG, flowId),
    );
    const body = await res.json();

    expect(res.status).toBe(422);
    expect(body.code).toBe("CONFIG");
  });

  it("returns 404 when flowId belongs to a different project", async () => {
    // otherFlowId lives in OTHER_PROJECT_ID, asking via PROJECT_SLUG must 404.
    sessionRef.value = { user: { id: "u-admin", role: "admin" } };

    const res = await PATCH(
      makeRequest(PROJECT_SLUG, otherFlowId, { binding: "pinned" }),
      params(PROJECT_SLUG, otherFlowId),
    );

    expect(res.status).toBe(404);
  });

  it("returns 404 for a completely unknown flowId", async () => {
    sessionRef.value = { user: { id: "u-admin", role: "admin" } };
    const unknownId = randomUUID();

    const res = await PATCH(
      makeRequest(PROJECT_SLUG, unknownId, { binding: "pinned" }),
      params(PROJECT_SLUG, unknownId),
    );

    expect(res.status).toBe(404);
  });
});

describe("PATCH /api/projects/[slug]/flows/[flowId]/version-binding — RBAC (integration)", () => {
  it("returns 403 for a project member (insufficient role for managePackages)", async () => {
    // u-member has 'member' role on PROJECT_ID — managePackages requires 'admin'.
    sessionRef.value = { user: { id: "u-member", role: "member" } };

    const res = await PATCH(
      makeRequest(PROJECT_SLUG, flowId, { binding: "latest" }),
      params(PROJECT_SLUG, flowId),
    );

    expect(res.status).toBe(403);
  });

  it("returns 200 for a project-level admin (has managePackages)", async () => {
    sessionRef.value = { user: { id: "u-pkg-admin", role: "member" } };

    const res = await PATCH(
      makeRequest(PROJECT_SLUG, flowId, { binding: "latest" }),
      params(PROJECT_SLUG, flowId),
    );

    expect(res.status).toBe(200);
  });
});
