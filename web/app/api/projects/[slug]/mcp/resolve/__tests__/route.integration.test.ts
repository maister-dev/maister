// M27/T-C7 (setup-resolve, ADR-070): setup-time MCP resolve-by-id route against
// a real testcontainer postgres. POST classifies each required mcp ref id
// against the project's mcp capability_records: "present" (a winner record
// exists, local-first scope) vs "absent" (propose-to-configure). Proves: RBAC
// (project viewer → 403), present id, absent id, local-first winner across
// scopes, and the security boundary — a record in another project does NOT make
// the id present here (project derived from slug, never the body). Invalid body
// → 422. Docker-only (skipped where the daemon is absent), like the other
// *.integration.test.ts. RED until app/api/projects/[slug]/mcp/resolve/route.ts
// exists.
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

let route: typeof import("@/app/api/projects/[slug]/mcp/resolve/route");

const PROJECT_A_ID = randomUUID();
const PROJECT_A_SLUG = `proj-resolve-${randomUUID()}`;
const PROJECT_B_ID = randomUUID();
const PROJECT_B_SLUG = `proj-resolve-other-${randomUUID()}`;

const ADMIN = { user: { id: "u-admin", role: "admin" } };

type Resolution =
  | { refId: string; status: "present"; recordId: string; scope: string }
  | { refId: string; status: "absent" };

function request(slug: string, body?: unknown) {
  return new NextRequest(`http://localhost/api/projects/${slug}/mcp/resolve`, {
    method: "POST",
    ...(body === undefined
      ? {}
      : {
          body: JSON.stringify(body),
          headers: { "content-type": "application/json" },
        }),
  });
}

function ctx(slug: string) {
  return { params: Promise.resolve({ slug }) };
}

async function resolve(
  slug: string,
  body: unknown,
): Promise<{ status: number; resolutions: Resolution[] }> {
  const res = await route.POST(request(slug, body), ctx(slug));
  const json = (await res.json().catch(() => ({}))) as {
    resolutions?: Resolution[];
  };

  return { status: res.status, resolutions: json.resolutions ?? [] };
}

async function seedMcp(
  projectId: string,
  capabilityRefId: string,
  source: "platform" | "project" | "flow-package",
  opts: { id?: string; disabled?: boolean } = {},
): Promise<string> {
  const id = opts.id ?? randomUUID();

  await db.insert(schema.capabilityRecords).values({
    id,
    projectId,
    capabilityRefId,
    kind: "mcp",
    label: capabilityRefId,
    source,
    agents: ["claude", "codex"],
    enforceability: "instructed",
    selectedByDefault: true,
    selectable: opts.disabled ? false : true,
    material: {},
    disabledAt: opts.disabled ? new Date() : null,
  });

  return id;
}

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("mcp_resolve_test")
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
  ]);

  await db.insert(schema.projectMembers).values([
    {
      id: randomUUID(),
      projectId: PROJECT_A_ID,
      userId: "u-viewer",
      role: "viewer",
    },
  ]);

  route = await import("@/app/api/projects/[slug]/mcp/resolve/route");
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

describe("setup-resolve MCP route (real postgres)", () => {
  it("403 for a project viewer (below manageCatalog)", async () => {
    sessionRef.value = { user: { id: "u-viewer", role: "member" } };

    const res = await route.POST(
      request(PROJECT_A_SLUG, { requiredIds: ["anything"] }),
      ctx(PROJECT_A_SLUG),
    );

    expect(res.status).toBe(403);
  });

  it("classifies a present id with its recordId + scope", async () => {
    sessionRef.value = ADMIN;
    const ref = `present-${randomUUID().slice(0, 8)}`;
    const recordId = await seedMcp(PROJECT_A_ID, ref, "project");

    const { status, resolutions } = await resolve(PROJECT_A_SLUG, {
      requiredIds: [ref],
    });

    expect(status).toBe(200);
    expect(resolutions).toEqual([
      { refId: ref, status: "present", recordId, scope: "project" },
    ]);
  });

  it("classifies an absent id as propose-to-configure", async () => {
    sessionRef.value = ADMIN;
    const ref = `absent-${randomUUID().slice(0, 8)}`;

    const { status, resolutions } = await resolve(PROJECT_A_SLUG, {
      requiredIds: [ref],
    });

    expect(status).toBe(200);
    expect(resolutions).toEqual([{ refId: ref, status: "absent" }]);
  });

  it("picks the local-first winner when the same id exists at multiple scopes", async () => {
    sessionRef.value = ADMIN;
    const ref = `multi-${randomUUID().slice(0, 8)}`;

    await seedMcp(PROJECT_A_ID, ref, "flow-package");
    await seedMcp(PROJECT_A_ID, ref, "platform");
    const projectRowId = await seedMcp(PROJECT_A_ID, ref, "project");

    const { status, resolutions } = await resolve(PROJECT_A_SLUG, {
      requiredIds: [ref],
    });

    expect(status).toBe(200);
    expect(resolutions).toEqual([
      {
        refId: ref,
        status: "present",
        recordId: projectRowId,
        scope: "project",
      },
    ]);
  });

  it("does not treat another project's record as present (project scoping)", async () => {
    sessionRef.value = ADMIN;
    const ref = `scoped-${randomUUID().slice(0, 8)}`;

    // Only project B has this mcp; project A must see it as absent.
    await seedMcp(PROJECT_B_ID, ref, "project");

    const { status, resolutions } = await resolve(PROJECT_A_SLUG, {
      requiredIds: [ref],
    });

    expect(status).toBe(200);
    expect(resolutions).toEqual([{ refId: ref, status: "absent" }]);
  });

  it("422 on an invalid body (empty requiredIds entry)", async () => {
    sessionRef.value = ADMIN;

    const res = await route.POST(
      request(PROJECT_A_SLUG, { requiredIds: [""] }),
      ctx(PROJECT_A_SLUG),
    );

    expect(res.status).toBe(422);
  });
});
