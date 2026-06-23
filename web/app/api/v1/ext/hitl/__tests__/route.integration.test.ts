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
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { testPlatformRunnerRow } from "@/lib/__tests__/runner-fixtures";
import * as schemaModule from "@/lib/db/schema";
import { issueToken } from "@/lib/tokens/issue";

const schema = schemaModule as unknown as Record<string, any>;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;
let GET: typeof import("@/app/api/v1/ext/hitl/route").GET;

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("ext_hitl_inbox_route_test")
    .withUsername("test")
    .withPassword("test")
    .start();

  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);

  await migrate(db, { migrationsFolder: "./lib/db/migrations" });

  const routeModule = await import("@/app/api/v1/ext/hitl/route");

  GET = routeModule.GET;
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

beforeEach(async () => {
  await db.delete(schema.tokenAuditLog as any);
});

async function seedUser(emailPrefix: string): Promise<string> {
  const userId = randomUUID();

  await (db as any).insert(schema.users).values({
    id: userId,
    email: `${emailPrefix}-${userId.slice(0, 8)}@example.test`,
    role: "member",
    accountStatus: "active",
    passwordHash: "x",
  });

  return userId;
}

async function seedProject(slug: string) {
  const projectId = randomUUID();
  const flowId = randomUUID();
  const runnerId = randomUUID();

  await (db as any).insert(schema.projects).values({
    id: projectId,
    slug,
    name: `Project ${slug}`,
    repoPath: `/tmp/${slug}`,
    maisterYamlPath: `/tmp/${slug}/maister.yaml`,
    taskKey: `T${crypto.randomUUID().slice(0, 8)}`.toUpperCase(),
  });

  await (db as any)
    .insert(schema.platformAcpRunners)
    .values(testPlatformRunnerRow(runnerId, "claude"));

  await (db as any).insert(schema.flows).values({
    id: flowId,
    projectId,
    flowRefId: "bugfix",
    source: "github.com/x/y",
    version: "v1.0.0",
    installedPath: "/tmp/flows/bugfix",
    manifest: {
      schemaVersion: 1,
      name: "Bugfix",
      steps: [{ id: "review", type: "human_review" }],
    },
    schemaVersion: 1,
  });

  return { projectId, slug, flowId, runnerId };
}

async function seedProjectMember(
  projectId: string,
  userId: string,
): Promise<void> {
  await (db as any).insert(schema.projectMembers).values({
    projectId,
    userId,
    role: "member",
  });
}

async function seedPendingHitl(args: {
  projectId: string;
  flowId: string;
  runnerId: string;
  title: string;
  kind?: "permission" | "form" | "human";
}): Promise<{ runId: string; hitlRequestId: string }> {
  const taskId = randomUUID();
  const runId = randomUUID();
  const workspaceId = randomUUID();
  const hitlRequestId = randomUUID();

  await (db as any).insert(schema.tasks).values({
    id: taskId,
    projectId: args.projectId,
    flowId: args.flowId,
    number: Math.trunc(Math.random() * 1e9) + 1,
    title: args.title,
    prompt: "Need a human decision",
    status: "InFlight",
    stage: "InFlight",
    attemptNumber: 1,
  });

  await (db as any).insert(schema.runs).values({
    id: runId,
    projectId: args.projectId,
    taskId,
    flowId: args.flowId,
    runnerId: args.runnerId,
    runnerSnapshot: {
      id: args.runnerId,
      adapter: "claude",
      capabilityAgent: "claude",
      model: "sonnet",
      providerKind: "anthropic",
      provider: { kind: "anthropic" },
      permissionPolicy: "default",
    },
    capabilityAgent: "claude",
    status: "NeedsInput",
    flowVersion: "v1.0.0",
    currentStepId: "review",
  });

  await (db as any).insert(schema.workspaces).values({
    id: workspaceId,
    projectId: args.projectId,
    runId,
    branch: `feature/${taskId.slice(0, 8)}`,
    worktreePath: `/tmp/maister/${args.projectId}/runs/${runId}`,
    parentRepoPath: `/tmp/maister/${args.projectId}`,
  });

  await (db as any).insert(schema.hitlRequests).values({
    id: hitlRequestId,
    runId,
    stepId: "review",
    kind: args.kind ?? "human",
    prompt: "Review deployment plan",
    schema: null,
  });

  return { runId, hitlRequestId };
}

async function issueGlobalUserToken(
  ownerUserId: string,
  scopes: Parameters<typeof issueToken>[0]["scopes"],
) {
  return issueToken(
    {
      projectId: null as unknown as string,
      name: "Human Inbox Token",
      tokenKind: "user",
      ownerUserId,
      scopes,
    },
    db,
  );
}

function makeRequest(token: string): NextRequest {
  return new NextRequest("http://localhost/api/v1/ext/hitl", {
    method: "GET",
    headers: { authorization: `Bearer ${token}` },
  });
}

describe("GET /api/v1/ext/hitl", () => {
  it("lists pending HITL across owner-visible projects and audits project_id NULL", async () => {
    const ownerUserId = await seedUser("hitl-inbox-owner");
    const firstProject = await seedProject(
      `ext-hitl-inbox-a-${randomUUID().slice(0, 8)}`,
    );
    const secondProject = await seedProject(
      `ext-hitl-inbox-b-${randomUUID().slice(0, 8)}`,
    );

    await seedProjectMember(firstProject.projectId, ownerUserId);
    await seedProjectMember(secondProject.projectId, ownerUserId);

    const firstHitl = await seedPendingHitl({
      ...firstProject,
      title: "First visible HITL",
    });
    const secondHitl = await seedPendingHitl({
      ...secondProject,
      title: "Second visible HITL",
    });
    const token = await issueGlobalUserToken(ownerUserId, ["hitl:inbox:read"]);

    const res = await GET(makeRequest(token.secret));

    expect(res.status).toBe(200);

    const body = await res.json();

    expect(body.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          projectId: firstProject.projectId,
          projectSlug: firstProject.slug,
          runId: firstHitl.runId,
          hitlRequestId: firstHitl.hitlRequestId,
          kind: "human",
        }),
        expect.objectContaining({
          projectId: secondProject.projectId,
          projectSlug: secondProject.slug,
          runId: secondHitl.runId,
          hitlRequestId: secondHitl.hitlRequestId,
          kind: "human",
        }),
      ]),
    );

    const auditRows = await db
      .select()
      .from(schema.tokenAuditLog as any)
      .execute();

    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      token_id: token.tokenId,
      project_id: null,
      result: "ok",
      status_code: 200,
      scope_used: "hitl:inbox:read",
      endpoint: "GET /api/v1/ext/hitl",
    });
  });

  it("hides HITL from projects outside the token owner's access", async () => {
    const ownerUserId = await seedUser("hitl-inbox-filter");
    const visibleProject = await seedProject(
      `ext-hitl-inbox-visible-${randomUUID().slice(0, 8)}`,
    );
    const hiddenProject = await seedProject(
      `ext-hitl-inbox-hidden-${randomUUID().slice(0, 8)}`,
    );

    await seedProjectMember(visibleProject.projectId, ownerUserId);

    const visibleHitl = await seedPendingHitl({
      ...visibleProject,
      title: "Visible HITL",
    });

    await seedPendingHitl({
      ...hiddenProject,
      title: "Hidden HITL",
    });

    const token = await issueGlobalUserToken(ownerUserId, ["*"]);
    const res = await GET(makeRequest(token.secret));

    expect(res.status).toBe(200);

    const body = await res.json();

    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      projectId: visibleProject.projectId,
      hitlRequestId: visibleHitl.hitlRequestId,
    });
  });

  it("rejects project-bound tokens because the inbox is user-wide", async () => {
    const project = await seedProject(
      `ext-hitl-inbox-project-token-${randomUUID().slice(0, 8)}`,
    );
    const token = await issueToken(
      {
        projectId: project.projectId,
        name: "Project Token",
        scopes: ["hitl:inbox:read" as never],
      },
      db,
    );

    const res = await GET(makeRequest(token.secret));

    expect(res.status).toBe(403);

    const auditRows = await db
      .select()
      .from(schema.tokenAuditLog as any)
      .execute();

    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      token_id: token.tokenId,
      project_id: null,
      result: "error",
      status_code: 403,
      scope_used: "hitl:inbox:read",
    });
  });
});
