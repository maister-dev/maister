// IT-ATN-08 / CT-ATN-06 (ADR-169) — `GET /api/v1/ext/decisions`.
//
// A decision queue is a PERSON's queue, so this is the narrowest ext actor in
// the system: a global personal token and nothing else. Every negative is
// asserted beside a positive grant — a route that 403s everything would pass a
// deny-only suite while being completely broken.
//
// ATN-08: a `decision_request` HITL row must not appear on ANY external
// surface, and the fixture seeds a real one so the filter has something to drop.

import { randomUUID } from "node:crypto";

import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { NextRequest } from "next/server";
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
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

// FIXME(any): drizzle-orm dual peer-dep variants — same cast the sibling ext
// route tests use for their fixture inserts.
const schema = schemaModule as unknown as Record<string, any>;

let testDatabase: StartedPostgresTestDb;
let db: NodePgDatabase;
let GET: typeof import("@/app/api/v1/ext/decisions/route").GET;

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "ext_decisions_route_test",
  });
  db = testDatabase.db;
  ({ GET } = await import("@/app/api/v1/ext/decisions/route"));
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

beforeEach(async () => {
  await db.delete(schema.tokenAuditLog as any);
});

async function seedUser(prefix: string): Promise<string> {
  const userId = randomUUID();

  await (db as any).insert(schema.users).values({
    id: userId,
    email: `${prefix}-${userId.slice(0, 8)}@example.test`,
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
    taskKey: `T${randomUUID().slice(0, 8)}`.toUpperCase(),
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
    manifest: { schemaVersion: 1, name: "Bugfix", nodes: [] },
    schemaVersion: 1,
  });

  return { projectId, slug, flowId, runnerId };
}

async function seedMember(projectId: string, userId: string): Promise<void> {
  await (db as any)
    .insert(schema.projectMembers)
    .values({ projectId, userId, role: "member" });
}

// A `decision_request` is a CHILD row (ADR-137): it needs a parent HITL, the
// plan artifact it was extracted from, and a decision id, all enforced by
// `hitl_requests_decision_request_shape_check`. Seeding a real one is the point
// — a filter tested against a row that could not exist proves nothing.
async function seedDecisionRequest(
  runId: string,
): Promise<{ hitlRequestId: string }> {
  const parentHitlRequestId = randomUUID();
  const artifactId = randomUUID();
  const attemptId = randomUUID();
  const hitlRequestId = randomUUID();

  await (db as any).insert(schema.hitlRequests).values({
    id: parentHitlRequestId,
    runId,
    stepId: "plan_review",
    kind: "human",
    prompt: "Approve the plan",
    schema: null,
  });
  await (db as any).insert(schema.nodeAttempts).values({
    id: attemptId,
    runId,
    nodeId: "plan",
    nodeType: "ai_coding",
    attempt: 1,
    status: "Succeeded",
    startedAt: new Date("2026-09-10T09:00:00.000Z"),
  });
  await (db as any).insert(schema.artifactInstances).values({
    id: artifactId,
    runId,
    nodeAttemptId: attemptId,
    nodeId: "plan",
    attempt: 1,
    artifactDefId: "plan",
    kind: "plan",
    producer: "runner",
    locator: { kind: "inline", text: "the plan" },
    validity: "current",
  });
  await (db as any).insert(schema.hitlRequests).values({
    id: hitlRequestId,
    runId,
    stepId: "plan_review",
    kind: "decision_request",
    prompt: "An agent-to-agent decision request",
    parentHitlRequestId,
    sourceArtifactId: artifactId,
    decisionId: "database",
    schema: {
      version: 1,
      sourceArtifactId: artifactId,
      decisionId: "database",
      question: "which store?",
      options: [{ id: "postgres", label: "Postgres" }],
    },
  });

  return { hitlRequestId };
}

async function seedHitl(args: {
  projectId: string;
  flowId: string;
  runnerId: string;
  kind: "human";
  title: string;
}): Promise<{ runId: string; hitlRequestId: string }> {
  const taskId = randomUUID();
  const runId = randomUUID();
  const hitlRequestId = randomUUID();

  await (db as any).insert(schema.tasks).values({
    id: taskId,
    projectId: args.projectId,
    flowId: args.flowId,
    number: Math.trunc(Math.random() * 1e9) + 1,
    title: args.title,
    prompt: "p",
    status: "InFlight",
    stage: "Backlog",
    attemptNumber: 1,
  });
  await (db as any).insert(schema.runs).values({
    id: runId,
    projectId: args.projectId,
    taskId,
    flowId: args.flowId,
    status: "NeedsInput",
    flowVersion: "v1.0.0",
    currentStepId: "review",
  });
  await (db as any).insert(schema.runSessions).values({
    id: randomUUID(),
    runId,
    sessionName: "default",
    runnerId: args.runnerId,
    capabilityAgent: "claude",
    runnerSnapshot: {
      id: args.runnerId,
      adapter: "claude",
      capabilityAgent: "claude",
      model: "sonnet",
      providerKind: "anthropic",
      provider: { kind: "anthropic" },
      permissionPolicy: "default",
    },
  });
  await (db as any).insert(schema.workspaces).values({
    id: randomUUID(),
    projectId: args.projectId,
    runId,
    branch: `feature/${runId.slice(0, 8)}`,
    worktreePath: `/tmp/wt/${runId}`,
    parentRepoPath: `/tmp/parent`,
  });
  await (db as any).insert(schema.hitlRequests).values({
    id: hitlRequestId,
    runId,
    stepId: "review",
    kind: args.kind,
    prompt: args.title,
    schema: null,
  });

  return { runId, hitlRequestId };
}

async function globalUserToken(
  ownerUserId: string,
  scopes: Parameters<typeof issueToken>[0]["scopes"],
) {
  return issueToken(
    {
      projectId: null as unknown as string,
      name: "Decisions Token",
      tokenKind: "user",
      ownerUserId,
      scopes,
    },
    db,
  );
}

function request(token: string): NextRequest {
  return new NextRequest("http://localhost/api/v1/ext/decisions", {
    method: "GET",
    headers: { authorization: `Bearer ${token}` },
  });
}

describe("IT-ATN-08 GET /api/v1/ext/decisions", () => {
  it("grants a global personal token its own queue, in the documented shape", async () => {
    const owner = await seedUser("dec-owner");
    const project = await seedProject(`ext-dec-${randomUUID().slice(0, 8)}`);

    await seedMember(project.projectId, owner);

    const hitl = await seedHitl({
      ...project,
      kind: "human",
      title: "Review deployment plan",
    });
    const token = await globalUserToken(owner, ["decisions:read"]);
    const res = await GET(request(token.secret));

    expect(res.status).toBe(200);

    const body = await res.json();

    // toEqual is an EXACT-shape assertion: an extra key on either side fails.
    // The internal item carries the whole HITL payload — schema, assignment,
    // agent — and none of it may cross this boundary.
    expect(body.items).toEqual([
      {
        kind: "hitl",
        projectId: project.projectId,
        projectSlug: project.slug,
        taskKey: expect.any(String),
        runId: hitl.runId,
        hitlRequestId: hitl.hitlRequestId,
        title: "Review deployment plan",
        criticality: null,
        nextAction: "respond",
        createdAt: expect.any(String),
      },
    ]);
    expect(body.count).toBe(body.items.length);
    expect(new Date(body.items[0].createdAt).toISOString()).toBe(
      body.items[0].createdAt,
    );
  });

  it("never surfaces a decision_request row", async () => {
    const owner = await seedUser("dec-filter-owner");
    const project = await seedProject(`ext-dec-f-${randomUUID().slice(0, 8)}`);

    await seedMember(project.projectId, owner);

    const visible = await seedHitl({
      ...project,
      kind: "human",
      title: "A normal human decision",
    });
    const hidden = await seedDecisionRequest(visible.runId);
    const token = await globalUserToken(owner, ["decisions:read"]);
    const res = await GET(request(token.secret));
    const body = await res.json();
    const ids = body.items.map(
      (item: { hitlRequestId: string | null }) => item.hitlRequestId,
    );

    // Both directions: the filter drops the right row AND keeps the other one,
    // so a filter that dropped everything would still fail here.
    expect(ids).toContain(visible.hitlRequestId);
    expect(ids).not.toContain(hidden.hitlRequestId);
  });

  it("accepts a `*` grant — decisions:read is not an exact-only scope", async () => {
    const owner = await seedUser("dec-star-owner");
    const project = await seedProject(`ext-dec-s-${randomUUID().slice(0, 8)}`);

    await seedMember(project.projectId, owner);
    await seedHitl({ ...project, kind: "human", title: "Star grant" });

    const token = await globalUserToken(owner, ["*"]);
    const res = await GET(request(token.secret));

    expect(res.status).toBe(200);
    expect((await res.json()).count).toBeGreaterThan(0);
  });

  it("refuses a project-bound token — a project has no decision queue", async () => {
    const project = await seedProject(`ext-dec-p-${randomUUID().slice(0, 8)}`);
    const token = await issueToken(
      {
        projectId: project.projectId,
        name: "Project Token",
        scopes: ["decisions:read" as never],
      },
      db,
    );
    const res = await GET(request(token.secret));

    expect(res.status).toBe(403);

    const auditRows = await db
      .select()
      .from(schema.tokenAuditLog as any)
      .execute();

    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      project_id: null,
      result: "error",
      status_code: 403,
      scope_used: "decisions:read",
    });
  });

  it("refuses a token that does not carry the scope at all", async () => {
    const owner = await seedUser("dec-noscope-owner");
    const token = await globalUserToken(owner, ["tasks:read"]);
    const res = await GET(request(token.secret));

    expect(res.status).toBe(403);
  });
});

describe("UT-NTF-09 decisions:read is not an agent scope", () => {
  it("is absent from both agent scope allow-lists", async () => {
    const { AGENT_TOKEN_SCOPES, CROSS_PROJECT_AGENT_SCOPES } = await import(
      "@/types/token-scopes"
    );

    expect(AGENT_TOKEN_SCOPES as readonly string[]).not.toContain(
      "decisions:read",
    );
    expect(CROSS_PROJECT_AGENT_SCOPES as readonly string[]).not.toContain(
      "decisions:read",
    );
  });

  it("still lists scopes an agent DOES get, so the assertion means something", async () => {
    const { AGENT_TOKEN_SCOPES } = await import("@/types/token-scopes");

    expect(AGENT_TOKEN_SCOPES.length).toBeGreaterThan(0);
  });
});
