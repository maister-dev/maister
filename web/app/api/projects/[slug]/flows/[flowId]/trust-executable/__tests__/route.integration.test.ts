/**
 * Route integration test for POST /api/projects/[slug]/flows/[flowId]/trust-executable.
 *
 * Mirrors the version-binding route test structure.
 * Covers: 200 (admin, project-admin), 403 (member lacking managePackages),
 * 404/409 (no such project or flow).
 */

import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

import { buildFlowFixture } from "@/lib/__tests__/_fixtures/build-flow-plugin";
import * as schemaModule from "@/lib/db/schema";
import { installFlowPlugin } from "@/lib/flows";

const schema = schemaModule as unknown as Record<string, any>;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;
let homeDir: string;
let workspaceRoot: string;
let fixturesDir: string;
let setupOkRepo: string;
let originalHome: string | undefined;

const sessionRef: { value: unknown } = { value: null };

vi.mock("@/auth", () => ({
  auth: vi.fn(async () => sessionRef.value),
  signIn: vi.fn(),
  signOut: vi.fn(),
  handlers: {},
}));

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

let POST: typeof import("@/app/api/projects/[slug]/flows/[flowId]/trust-executable/route").POST;

const PROJECT_ID = randomUUID();
const PROJECT_SLUG = `proj-te-${randomUUID()}`;

// Flow IDs used across tests.
let flowIdNoSetup: string;
let flowIdWithSetup: string;

function makeRequest(slug: string, fId: string): NextRequest {
  return new NextRequest(
    `http://localhost/api/projects/${slug}/flows/${fId}/trust-executable`,
    { method: "POST" },
  );
}

function params(slug: string, fId: string) {
  return { params: Promise.resolve({ slug, flowId: fId }) };
}

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("trust_exec_route_test")
    .withUsername("test")
    .withPassword("test")
    .start();

  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);
  await migrate(db, { migrationsFolder: "./lib/db/migrations" });

  homeDir = await mkdtemp(join(tmpdir(), "te-route-home-"));
  workspaceRoot = await mkdtemp(join(tmpdir(), "te-route-ws-"));
  fixturesDir = await mkdtemp(join(tmpdir(), "te-route-fixtures-"));
  originalHome = process.env.HOME;
  process.env.HOME = homeDir;

  setupOkRepo = await buildFlowFixture(fixturesDir, "with-setup-ok");

  await db.insert(schema.projects).values({ taskKey: `T${crypto.randomUUID().slice(0, 8)}`.toUpperCase(),
    id: PROJECT_ID,
    slug: PROJECT_SLUG,
    name: PROJECT_SLUG,
    repoPath: workspaceRoot,
    maisterYamlPath: join(workspaceRoot, "maister.yaml"),
  });

  await db.insert(schema.users).values([
    {
      id: "u-te-admin",
      email: "admin@te.test",
      role: "admin",
      passwordHash: "x",
      accountStatus: "active",
    },
    {
      id: "u-te-member",
      email: "member@te.test",
      role: "member",
      passwordHash: "x",
      accountStatus: "active",
    },
    {
      id: "u-te-pkg-admin",
      email: "pkgadmin@te.test",
      role: "member",
      passwordHash: "x",
      accountStatus: "active",
    },
  ]);

  await db.insert(schema.projectMembers).values([
    {
      id: randomUUID(),
      projectId: PROJECT_ID,
      userId: "u-te-member",
      role: "member",
    },
    {
      id: randomUUID(),
      projectId: PROJECT_ID,
      userId: "u-te-pkg-admin",
      role: "admin",
    },
  ]);

  // Install a flow without setup.sh (valid flow).
  const validRepo = await buildFlowFixture(fixturesDir, "valid");
  const noSetupResult = await installFlowPlugin({
    source: validRepo,
    version: "v1.0.0",
    projectId: PROJECT_ID,
    projectSlug: PROJECT_SLUG,
    flowId: "no-setup-flow",
    workspaceRoot,
    db,
  });

  flowIdNoSetup = noSetupResult.flowRowId;

  // Install a flow with setup.sh, then manually reset exec_trust='untrusted'
  // and setupStatus='pending' to simulate an authored-bridge state.
  const setupResult = await installFlowPlugin({
    source: setupOkRepo,
    version: "v1.0.0",
    projectId: PROJECT_ID,
    projectSlug: PROJECT_SLUG,
    flowId: "with-setup-flow",
    workspaceRoot,
    db,
  });

  flowIdWithSetup = setupResult.flowRowId;

  // Manually set exec_trust='untrusted' + setupStatus='pending' on the revision.
  await db
    .update(schema.flowRevisions)
    .set({ execTrust: "untrusted", setupStatus: "pending" })
    .where(eq(schema.flowRevisions.id, setupResult.revisionId));

  ({ POST } = await import(
    "@/app/api/projects/[slug]/flows/[flowId]/trust-executable/route"
  ));
}, 180_000);

afterAll(async () => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;

  await pool?.end();
  await container?.stop();
  await rm(homeDir, { recursive: true, force: true });
  await rm(workspaceRoot, { recursive: true, force: true });
  await rm(fixturesDir, { recursive: true, force: true });
});

describe("POST /api/projects/[slug]/flows/[flowId]/trust-executable (integration)", () => {
  it("200 — global admin can trust-executable a flow with no setup.sh", async () => {
    sessionRef.value = { user: { id: "u-te-admin", role: "admin" } };

    const res = await POST(
      makeRequest(PROJECT_SLUG, flowIdNoSetup),
      params(PROJECT_SLUG, flowIdNoSetup),
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.execTrust).toBe("trusted");
  });

  it("200 — project admin (managePackages) can trust-executable; setup.sh runs for pending revision", async () => {
    sessionRef.value = { user: { id: "u-te-pkg-admin", role: "member" } };

    const res = await POST(
      makeRequest(PROJECT_SLUG, flowIdWithSetup),
      params(PROJECT_SLUG, flowIdWithSetup),
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.execTrust).toBe("trusted");
    expect(body.setupStatus).toBe("done");
  });

  it("403 — project member (not admin) cannot trust-executable", async () => {
    sessionRef.value = { user: { id: "u-te-member", role: "member" } };

    const res = await POST(
      makeRequest(PROJECT_SLUG, flowIdNoSetup),
      params(PROJECT_SLUG, flowIdNoSetup),
    );

    expect(res.status).toBe(403);
  });

  it("409 — project not found returns error", async () => {
    sessionRef.value = { user: { id: "u-te-admin", role: "admin" } };

    const res = await POST(
      makeRequest("no-such-project", flowIdNoSetup),
      params("no-such-project", flowIdNoSetup),
    );

    expect(res.status).toBe(409);
  });

  it("409 — flow not found for project returns PRECONDITION error", async () => {
    sessionRef.value = { user: { id: "u-te-admin", role: "admin" } };

    const unknownFlowId = randomUUID();
    const res = await POST(
      makeRequest(PROJECT_SLUG, unknownFlowId),
      params(PROJECT_SLUG, unknownFlowId),
    );

    expect(res.status).toBe(409);
  });
});
