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
import * as schemaModule from "@/lib/db/schema";

const schema = schemaModule as unknown as Record<string, any>;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

let GET: typeof import("@/app/api/v1/ext/projects/[slug]/flows/route").GET;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("ext_flows_route_test")
    .withUsername("test")
    .withPassword("test")
    .start();

  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);

  await migrate(db, { migrationsFolder: "./lib/db/migrations" });

  const routeModule = await import(
    "@/app/api/v1/ext/projects/[slug]/flows/route"
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

async function seedFlow(
  projectId: string,
  opts: {
    flowRefId: string;
    enablementState: string;
    trustStatus: string;
    metadata?: unknown;
    createdAt?: Date;
  },
): Promise<string> {
  const flowId = randomUUID();
  const manifest: Record<string, unknown> = {
    schemaVersion: 1,
    name: opts.flowRefId,
    steps: [],
  };

  if (opts.metadata !== undefined) manifest.metadata = opts.metadata;

  await db.insert(schema.flows).values({
    id: flowId,
    projectId,
    flowRefId: opts.flowRefId,
    source: "github.com/x/y",
    version: "v1.0.0",
    installedPath: `/tmp/flows/${opts.flowRefId}`,
    manifest,
    schemaVersion: 1,
    enablementState: opts.enablementState,
    trustStatus: opts.trustStatus,
    createdAt: opts.createdAt ?? new Date(),
  });

  return flowId;
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
  return new NextRequest(`http://localhost/api/v1/ext/projects/${slug}/flows`, {
    method: "GET",
    headers: { "content-type": "application/json" },
  });
}

beforeEach(async () => {
  await db.delete(schema.tokenAuditLog as any);
});

describe("GET /api/v1/ext/projects/[slug]/flows", () => {
  it("missing/invalid token → 401, no audit row", async () => {
    const slug = `ext-flows-401-${randomUUID().slice(0, 8)}`;

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

  it("token missing flows:read scope → 403, audit row", async () => {
    const slug = `ext-flows-403-${randomUUID().slice(0, 8)}`;
    const projectId = await seedProject(slug);

    const token = await issueToken(
      { projectId, name: "No-flows Token", scopes: ["tasks:read"] },
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
      scope_used: "flows:read",
    });
  });

  it("valid token → 200 with the EXACT launchable-only projection + audit row", async () => {
    const slug = `ext-flows-ok-${randomUUID().slice(0, 8)}`;
    const projectId = await seedProject(slug);

    // Launchable: Enabled + trusted, with full metadata.
    const enabledFlowId = await seedFlow(projectId, {
      flowRefId: "bugfix",
      enablementState: "Enabled",
      trustStatus: "trusted",
      metadata: {
        title: "Bugfix",
        summary: "Fix a bug",
        route_when: "use when there is a defect",
        labels: ["fix", "small"],
      },
      createdAt: new Date(Date.UTC(2026, 0, 1)),
    });

    // Launchable: UpdateAvailable + trusted_by_policy, NO metadata.
    const updateFlowId = await seedFlow(projectId, {
      flowRefId: "spec-kit",
      enablementState: "UpdateAvailable",
      trustStatus: "trusted_by_policy",
      createdAt: new Date(Date.UTC(2026, 0, 2)),
    });

    // Excluded: Enabled but UNTRUSTED.
    await seedFlow(projectId, {
      flowRefId: "untrusted-flow",
      enablementState: "Enabled",
      trustStatus: "untrusted",
      createdAt: new Date(Date.UTC(2026, 0, 3)),
    });

    // Excluded: trusted but DISABLED (non-launchable enablement state).
    await seedFlow(projectId, {
      flowRefId: "disabled-flow",
      enablementState: "Disabled",
      trustStatus: "trusted",
      createdAt: new Date(Date.UTC(2026, 0, 4)),
    });

    const token = await issueToken({ projectId, name: "Discovery Token" }, db);
    const req = makeRequest(slug);

    req.headers.set("authorization", `Bearer ${token.secret}`);

    const res = await GET(req, { params: Promise.resolve({ slug }) });

    expect(res.status).toBe(200);

    const body = await res.json();

    // Launchable-only, ordered by createdAt, EXACT shape (no extra keys).
    expect(body).toEqual({
      flows: [
        {
          id: enabledFlowId,
          ref: "bugfix",
          metadata: {
            title: "Bugfix",
            summary: "Fix a bug",
            route_when: "use when there is a defect",
            labels: ["fix", "small"],
          },
        },
        {
          id: updateFlowId,
          ref: "spec-kit",
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
      scope_used: "flows:read",
      endpoint: "GET /api/v1/ext/projects/[slug]/flows",
    });
  });

  it("cross-project slug (outside owner access) → 404, existence-hidden", async () => {
    const ownerUserId = await seedUser("flows-hidden");
    const visible = `ext-flows-visible-${randomUUID().slice(0, 8)}`;
    const hidden = `ext-flows-hidden-${randomUUID().slice(0, 8)}`;
    const visibleId = await seedProject(visible);
    const hiddenId = await seedProject(hidden);

    await seedProjectMember(visibleId, ownerUserId);
    await seedFlow(hiddenId, {
      flowRefId: "bugfix",
      enablementState: "Enabled",
      trustStatus: "trusted",
    });

    const token = await issueToken(
      {
        projectId: null as unknown as string,
        name: "Global Token",
        tokenKind: "user",
        ownerUserId,
        scopes: ["flows:read"],
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
      scope_used: "flows:read",
    });
  });
});
