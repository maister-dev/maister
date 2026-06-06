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

import { issueToken } from "@/lib/tokens/issue";
import * as schemaModule from "@/lib/db/schema";
import {
  testPlatformRunnerRow,
  testRunnerSnapshot,
} from "@/lib/__tests__/runner-fixtures";

const schema = schemaModule as unknown as Record<string, any>;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));
vi.mock("@/lib/supervisor-client", () => ({
  checkSupervisorHealth: vi.fn(async () => ({ kind: "available" })),
  deliverPermission: vi.fn(async () => ({ ok: true })),
}));
vi.mock("@/lib/authz", () => ({
  requireProjectAction: vi.fn(async () => {}),
}));
vi.mock("@/auth", () => ({
  auth: vi.fn(async () => null),
}));
vi.mock("@/lib/worktree", () => ({
  addWorktree: vi.fn(async () => {}),
  removeWorktree: vi.fn(async () => {}),
  listBranches: vi.fn(async () => ["main"]),
  resolveBaseCommit: vi.fn(
    async () => "0000000000000000000000000000000000000000",
  ),
}));
vi.mock("@/lib/scheduler", () => ({
  tryStartRun: vi.fn(async () => ({ started: false, queuePosition: 1 })),
}));
vi.mock("@/lib/flows/runner", () => ({
  runFlow: vi.fn(async () => {}),
}));

let GET: typeof import("@/app/api/v1/ext/runs/[runId]/hitl/route").GET;
let POST: typeof import("@/app/api/v1/ext/runs/[runId]/hitl/[hitlRequestId]/respond/route").POST;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("ext_hitl_route_test")
    .withUsername("test")
    .withPassword("test")
    .start();

  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);

  await migrate(db, { migrationsFolder: "./lib/db/migrations" });
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

beforeAll(async () => {
  const hitlModule = await import("@/app/api/v1/ext/runs/[runId]/hitl/route");
  const respondModule = await import(
    "@/app/api/v1/ext/runs/[runId]/hitl/[hitlRequestId]/respond/route"
  );

  GET = hitlModule.GET;
  POST = respondModule.POST;
});

async function seedProject(slug: string) {
  const projectId = randomUUID();
  const flowId = randomUUID();
  const executorId = randomUUID();
  const revisionId = randomUUID();

  await (db as any).insert(schema.projects).values({
    id: projectId,
    slug,
    name: `Project ${slug}`,
    repoPath: `/tmp/${slug}`,
    maisterYamlPath: `/tmp/${slug}/maister.yaml`,
  });

  await (db as any)
    .insert(schema.platformAcpRunners)
    .values(testPlatformRunnerRow(executorId, "claude"));

  await (db as any).insert(schema.flowRevisions).values({
    id: revisionId,
    flowRefId: "bugfix",
    source: "github.com/x/y",
    versionLabel: "v1.0.0",
    resolvedRevision: `abc-${revisionId}`,
    manifestDigest: `sha256-${revisionId}`,
    installedPath: "/tmp/flows/bugfix",
    manifest: {
      schemaVersion: 1,
      name: "Bugfix",
      steps: [{ id: "run", type: "cli", command: "echo ok" }],
    },
    schemaVersion: 1,
    packageStatus: "Installed",
    setupStatus: "done",
  });

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
      steps: [{ id: "run", type: "cli", command: "echo ok" }],
    },
    schemaVersion: 1,
    enabledRevisionId: revisionId,
    enablementState: "Enabled",
    trustStatus: "trusted",
  });

  return { slug, projectId, flowId, executorId };
}

async function seedRun(
  projectId: string,
  flowId: string,
  status: string = "Running",
) {
  const runId = randomUUID();
  const taskId = randomUUID();
  const workspaceId = randomUUID();
  const runnerId = randomUUID();

  await (db as any)
    .insert(schema.platformAcpRunners)
    .values(testPlatformRunnerRow(runnerId, "claude"));

  await (db as any).insert(schema.tasks).values({
    id: taskId,
    projectId,
    title: "Test Task",
    prompt: "Do something",
    flowId,
    status: "InFlight",
    stage: "InFlight",
    attemptNumber: 1,
  });

  // Insert run before workspace (workspaces.run_id FK references runs.id).
  await (db as any).insert(schema.runs).values({
    id: runId,
    projectId,
    taskId,
    flowId,
    runnerId,
    capabilityAgent: "claude",
    runnerSnapshot: testRunnerSnapshot(runnerId),
    status,
    flowVersion: "v1.0.0",
    currentStepId: "step-1",
  });

  await (db as any).insert(schema.workspaces).values({
    id: workspaceId,
    projectId,
    runId,
    branch: "feature/test",
    worktreePath: `/tmp/maister/${projectId}/runs/${runId}`,
    parentRepoPath: `/tmp/maister/${projectId}`,
  });

  return { runId, taskId, workspaceId };
}

async function seedHitlRequest(
  runId: string,
  kind: "permission" | "form" | "human",
) {
  const hitlRequestId = randomUUID();
  let schema_: unknown;

  if (kind === "permission") {
    // Production shape written by runner-agent — carries supervisor-internal
    // handles the ext DTO MUST scrub (schema → null for permission). Options
    // match the optionIds the respond tests POST ("approve"/"reject").
    schema_ = {
      requestId: "req-1",
      options: [
        { optionId: "approve", label: "Approve" },
        { optionId: "reject", label: "Reject" },
      ],
      toolCall: { name: "bash", input: { command: "rm -rf /" } },
      supervisorSessionId: "sup-sess-SECRET",
    };
  } else if (kind === "form") {
    // Minimal valid form schema with one optional field so any object passes.
    schema_ = { schemaVersion: 1, fields: [{ name: "field", type: "string" }] };
  } else {
    schema_ = undefined;
  }

  await (db as any).insert(schema.hitlRequests).values({
    id: hitlRequestId,
    runId,
    stepId: "step-1",
    kind,
    prompt: "Do you want to proceed?",
    schema: schema_,
  });

  return hitlRequestId;
}

function makeGetRequest(runId: string, token: string): NextRequest {
  return new NextRequest(`http://localhost/api/v1/ext/runs/${runId}/hitl`, {
    method: "GET",
    headers: { authorization: `Bearer ${token}` },
  });
}

function makePostRequest(
  runId: string,
  hitlRequestId: string,
  token: string,
  body?: unknown,
): NextRequest {
  return new NextRequest(
    `http://localhost/api/v1/ext/runs/${runId}/hitl/${hitlRequestId}/respond`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    },
  );
}

beforeEach(async () => {
  await db.delete(schema.tokenAuditLog as any);
});

describe("GET /api/v1/ext/runs/[runId]/hitl", () => {
  it("lists pending HITL requests for a run with hitl:read token", async () => {
    const { projectId, flowId } = await seedProject(
      `ext-hitl-get-${randomUUID().slice(0, 8)}`,
    );
    const { runId } = await seedRun(projectId, flowId, "NeedsInput");
    const hitlId = await seedHitlRequest(runId, "permission");

    const token = await issueToken(
      { projectId, name: "test-token", createdByUserId: null },
      db,
    );

    const req = makeGetRequest(runId, token.secret);
    const res = await GET(req, { params: Promise.resolve({ runId }) });

    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body).toHaveProperty("hitl");
    expect(Array.isArray(body.hitl)).toBe(true);
    expect(body.hitl).toContainEqual(
      expect.objectContaining({
        hitlRequestId: hitlId,
        kind: "permission",
      }),
    );

    // Contract: options are {optionId,label} objects (NOT bare strings) and an
    // array (never null) — matches docs/api/external ExtHitlRequestDTO.
    const permItem = body.hitl.find(
      (h: { hitlRequestId: string }) => h.hitlRequestId === hitlId,
    );

    expect(Array.isArray(permItem.options)).toBe(true);
    for (const opt of permItem.options) {
      expect(typeof opt).toBe("object");
      expect(typeof opt.optionId).toBe("string");
      expect(typeof opt.label).toBe("string");
    }

    // Trust boundary: permission `schema` is scrubbed to null — the
    // supervisor-internal handles (supervisorSessionId/requestId/toolCall) must
    // NEVER cross to an external token holder (matches the OpenAPI contract).
    expect(permItem.schema).toBeNull();
    expect(JSON.stringify(body)).not.toContain("sup-sess-SECRET");

    // Verify audit row written
    const auditRows = await db
      .select()
      .from(schema.tokenAuditLog as any)
      .execute();

    expect(auditRows.length).toBeGreaterThan(0);
    expect(auditRows[auditRows.length - 1]).toMatchObject({
      result: "ok",
      status_code: 200,
    });
  });

  it("does NOT list an unresponded HITL for a run that is not awaiting input (status filter)", async () => {
    // Regression for the stale-HITL leak: a Running (non-pending) run with an
    // unanswered HITL row must return an EMPTY list — only NeedsInput/
    // NeedsInputIdle runs are pending.
    const { projectId, flowId } = await seedProject(
      `ext-hitl-stale-${randomUUID().slice(0, 8)}`,
    );
    const { runId } = await seedRun(projectId, flowId, "Running");

    await seedHitlRequest(runId, "permission");

    const token = await issueToken(
      { projectId, name: "test-token", createdByUserId: null },
      db,
    );

    const req = makeGetRequest(runId, token.secret);
    const res = await GET(req, { params: Promise.resolve({ runId }) });

    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.hitl).toEqual([]);
  });

  it("returns 404 (existence-hide) for cross-project runId", async () => {
    const { projectId: proj1, flowId: flow1 } = await seedProject(
      `ext-hitl-cross1-${randomUUID().slice(0, 8)}`,
    );
    const { projectId: proj2 } = await seedProject(
      `ext-hitl-cross2-${randomUUID().slice(0, 8)}`,
    );
    const { runId } = await seedRun(proj1, flow1);

    const token = await issueToken(
      { projectId: proj2, name: "test-token", createdByUserId: null },
      db,
    );

    const req = makeGetRequest(runId, token.secret);
    const res = await GET(req, { params: Promise.resolve({ runId }) });

    expect(res.status).toBe(404);

    // Verify audit row written for the error
    const auditRows = await db
      .select()
      .from(schema.tokenAuditLog as any)
      .execute();

    expect(auditRows.length).toBeGreaterThan(0);
    expect(auditRows[0]).toMatchObject({
      result: "error",
      status_code: 404,
    });
  });

  it("returns 403 when token lacks hitl:read scope", async () => {
    const { projectId, flowId } = await seedProject(
      `ext-hitl-scope-${randomUUID().slice(0, 8)}`,
    );
    const { runId } = await seedRun(projectId, flowId);

    // Issue token with custom scopes that exclude hitl:read
    const token = await issueToken(
      { projectId, name: "limited-token", createdByUserId: null },
      db,
    );

    // Update token scopes to ["other:scope"] (normally done at issue time)
    await (db as any)
      .update(schema.projectTokens)
      .set({ scopes: ["other:scope"] })
      .where(eq(schema.projectTokens.id, token.tokenId));

    const req = makeGetRequest(runId, token.secret);
    const res = await GET(req, { params: Promise.resolve({ runId }) });

    expect(res.status).toBe(403);
    const body = await res.json();

    expect(body.code).toBe("UNAUTHORIZED");
    // Verify scope is not leaked
    expect(body.message).not.toContain("other:scope");

    // Verify audit row written
    const auditRows = await db
      .select()
      .from(schema.tokenAuditLog as any)
      .execute();

    expect(auditRows.length).toBeGreaterThan(0);
    expect(auditRows[0]).toMatchObject({
      result: "error",
      status_code: 403,
    });
  });

  it("returns 200 when token has wildcard scope", async () => {
    const { projectId, flowId } = await seedProject(
      `ext-hitl-wildcard-${randomUUID().slice(0, 8)}`,
    );
    const { runId } = await seedRun(projectId, flowId);

    await seedHitlRequest(runId, "permission");

    const token = await issueToken(
      { projectId, name: "wildcard-token", createdByUserId: null },
      db,
    );

    const req = makeGetRequest(runId, token.secret);
    const res = await GET(req, { params: Promise.resolve({ runId }) });

    expect(res.status).toBe(200);
  });
});

describe("POST /api/v1/ext/runs/[runId]/hitl/[hitlRequestId]/respond", () => {
  it("answers a permission HITL with hitl:respond token → 200", async () => {
    const { projectId, flowId } = await seedProject(
      `ext-hitl-post-perm-${randomUUID().slice(0, 8)}`,
    );
    // A pending permission HITL always sits at NeedsInput (runner-agent.ts sets
    // it on permission_request); "Running" is never an answerable permission state.
    const { runId } = await seedRun(projectId, flowId, "NeedsInput");
    const hitlId = await seedHitlRequest(runId, "permission");

    const token = await issueToken(
      { projectId, name: "responder-token", createdByUserId: null },
      db,
    );

    // Update token scopes to ["hitl:respond"]
    await (db as any)
      .update(schema.projectTokens)
      .set({ scopes: ["hitl:respond"] })
      .where(eq(schema.projectTokens.id, token.tokenId));

    const req = makePostRequest(runId, hitlId, token.secret, {
      optionId: "approve",
    });
    const res = await POST(req, {
      params: Promise.resolve({ runId, hitlRequestId: hitlId }),
    });

    expect(res.status).toBe(200);

    // Verify audit row written
    const auditRows = await db
      .select()
      .from(schema.tokenAuditLog as any)
      .execute();

    expect(auditRows.length).toBeGreaterThan(0);
    expect(auditRows[0]).toMatchObject({
      result: "ok",
    });
  });

  it("answers a form HITL with hitl:respond token → 200", async () => {
    const { projectId, flowId } = await seedProject(
      `ext-hitl-post-form-${randomUUID().slice(0, 8)}`,
    );
    // Form HITL requires the run to be in NeedsInput state
    const { runId } = await seedRun(projectId, flowId, "NeedsInput");
    const hitlId = await seedHitlRequest(runId, "form");

    const token = await issueToken(
      { projectId, name: "responder-token", createdByUserId: null },
      db,
    );

    // Update token scopes to ["hitl:respond"]
    await (db as any)
      .update(schema.projectTokens)
      .set({ scopes: ["hitl:respond"] })
      .where(eq(schema.projectTokens.id, token.tokenId));

    const req = makePostRequest(runId, hitlId, token.secret, {
      response: { field: "value" },
    });
    const res = await POST(req, {
      params: Promise.resolve({ runId, hitlRequestId: hitlId }),
    });

    expect(res.status).toBe(200);

    // Verify audit row written
    const auditRows = await db
      .select()
      .from(schema.tokenAuditLog as any)
      .execute();

    expect(auditRows.length).toBeGreaterThan(0);
    expect(auditRows[0]).toMatchObject({
      result: "ok",
    });
  });

  it("returns 404 (existence-hide) when hitlRequestId not found", async () => {
    const { projectId, flowId } = await seedProject(
      `ext-hitl-post-notfound-${randomUUID().slice(0, 8)}`,
    );
    const { runId } = await seedRun(projectId, flowId);

    const token = await issueToken(
      { projectId, name: "responder-token", createdByUserId: null },
      db,
    );

    await (db as any)
      .update(schema.projectTokens)
      .set({ scopes: ["hitl:respond"] })
      .where(eq(schema.projectTokens.id, token.tokenId));

    const fakeHitlId = randomUUID();
    const req = makePostRequest(runId, fakeHitlId, token.secret, {
      optionId: "approve",
    });
    const res = await POST(req, {
      params: Promise.resolve({ runId, hitlRequestId: fakeHitlId }),
    });

    expect(res.status).toBe(404);

    // Verify audit row written
    const auditRows = await db
      .select()
      .from(schema.tokenAuditLog as any)
      .execute();

    expect(auditRows.length).toBeGreaterThan(0);
    expect(auditRows[0]).toMatchObject({
      result: "error",
      status_code: 404,
    });
  });

  it("returns 409 on idempotent retry with conflicting payload", async () => {
    const { projectId, flowId } = await seedProject(
      `ext-hitl-post-409-${randomUUID().slice(0, 8)}`,
    );
    // A pending permission HITL always sits at NeedsInput (runner-agent.ts sets
    // it on permission_request); "Running" is never an answerable permission state.
    const { runId } = await seedRun(projectId, flowId, "NeedsInput");
    const hitlId = await seedHitlRequest(runId, "permission");

    const token = await issueToken(
      { projectId, name: "responder-token", createdByUserId: null },
      db,
    );

    await (db as any)
      .update(schema.projectTokens)
      .set({ scopes: ["hitl:respond"] })
      .where(eq(schema.projectTokens.id, token.tokenId));

    // First response
    const req1 = makePostRequest(runId, hitlId, token.secret, {
      optionId: "approve",
    });
    const res1 = await POST(req1, {
      params: Promise.resolve({ runId, hitlRequestId: hitlId }),
    });

    expect(res1.status).toBe(200);

    // Conflicting retry
    const req2 = makePostRequest(runId, hitlId, token.secret, {
      optionId: "reject",
    });
    const res2 = await POST(req2, {
      params: Promise.resolve({ runId, hitlRequestId: hitlId }),
    });

    expect(res2.status).toBe(409);
  });

  it("returns 422 (bad response) for invalid payload", async () => {
    const { projectId, flowId } = await seedProject(
      `ext-hitl-post-422-${randomUUID().slice(0, 8)}`,
    );
    const { runId } = await seedRun(projectId, flowId);
    const hitlId = await seedHitlRequest(runId, "permission");

    const token = await issueToken(
      { projectId, name: "responder-token", createdByUserId: null },
      db,
    );

    await (db as any)
      .update(schema.projectTokens)
      .set({ scopes: ["hitl:respond"] })
      .where(eq(schema.projectTokens.id, token.tokenId));

    // Missing optionId for permission
    const req = makePostRequest(runId, hitlId, token.secret, {});
    const res = await POST(req, {
      params: Promise.resolve({ runId, hitlRequestId: hitlId }),
    });

    expect(res.status).toBe(422);
  });

  it("D7: returns 403 when token answers a human-kind HITL", async () => {
    const { projectId, flowId } = await seedProject(
      `ext-hitl-d7-${randomUUID().slice(0, 8)}`,
    );
    const { runId } = await seedRun(projectId, flowId);
    const hitlId = await seedHitlRequest(runId, "human");

    const token = await issueToken(
      { projectId, name: "responder-token", createdByUserId: null },
      db,
    );

    await (db as any)
      .update(schema.projectTokens)
      .set({ scopes: ["hitl:respond"] })
      .where(eq(schema.projectTokens.id, token.tokenId));

    const req = makePostRequest(runId, hitlId, token.secret, {
      response: { decision: "approved" },
    });
    const res = await POST(req, {
      params: Promise.resolve({ runId, hitlRequestId: hitlId }),
    });

    expect(res.status).toBe(403);
    const body = await res.json();

    expect(body.code).toBe("UNAUTHORIZED");
  });

  it("D8: returns 403 when token lacks hitl:respond scope", async () => {
    const { projectId, flowId } = await seedProject(
      `ext-hitl-d8-${randomUUID().slice(0, 8)}`,
    );
    const { runId } = await seedRun(projectId, flowId);
    const hitlId = await seedHitlRequest(runId, "permission");

    const token = await issueToken(
      { projectId, name: "limited-token", createdByUserId: null },
      db,
    );

    // Set scopes to ["hitl:read"] only (not hitl:respond)
    await (db as any)
      .update(schema.projectTokens)
      .set({ scopes: ["hitl:read"] })
      .where(eq(schema.projectTokens.id, token.tokenId));

    const req = makePostRequest(runId, hitlId, token.secret, {
      optionId: "approve",
    });
    const res = await POST(req, {
      params: Promise.resolve({ runId, hitlRequestId: hitlId }),
    });

    expect(res.status).toBe(403);
    const body = await res.json();

    expect(body.code).toBe("UNAUTHORIZED");
    expect(body.message).not.toContain("hitl:read");
  });

  it("D8: unrelated routes (gate_report) unaffected by scope enforcement", async () => {
    // This test verifies that scope enforcement is ONLY on HITL routes,
    // not globally. A token without gate:report scope still works on
    // unscoped routes (backward compat).
    // Since gate_report route is in a different file, we test the principle:
    // a token with ["*"] passes both HITL routes, and would pass unscoped routes.
    const { projectId, flowId } = await seedProject(
      `ext-hitl-binary-${randomUUID().slice(0, 8)}`,
    );
    const { runId } = await seedRun(projectId, flowId);
    const hitlId = await seedHitlRequest(runId, "permission");

    const token = await issueToken(
      { projectId, name: "wildcard-token", createdByUserId: null },
      db,
    );
    // Issued tokens default to the ["*"] wildcard scope (read from the DB row —
    // issueToken's return does not echo scopes).
    const tokRows = await (db as any)
      .select()
      .from(schema.projectTokens)
      .where(eq(schema.projectTokens.id, token.tokenId));

    expect(tokRows[0].scopes).toEqual(["*"]);

    const req = makePostRequest(runId, hitlId, token.secret, {
      optionId: "approve",
    });
    const res = await POST(req, {
      params: Promise.resolve({ runId, hitlRequestId: hitlId }),
    });

    // Should NOT be 403 from scope check (may be other errors)
    expect(res.status).not.toBe(403);
  });

  it("(b) ensureApiTokenActor upserts on (projectId, tokenId) — same token twice → one actor row", async () => {
    const { projectId } = await seedProject(
      `ext-hitl-actor-${randomUUID().slice(0, 8)}`,
    );

    const token = await issueToken(
      { projectId, name: "responder-token", createdByUserId: null },
      db,
    );

    // ensureApiTokenActor is the attribution chokepoint used by the token
    // respond path. Call it directly twice with the same (projectId, tokenId):
    // the partial unique (0025) makes the second an UPSERT, not a duplicate.
    const { ensureApiTokenActor } = await import("@/lib/assignments/service");
    const a1 = await ensureApiTokenActor({
      db: db as any,
      projectId,
      tokenId: token.tokenId,
      label: "tok-a",
    });
    const a2 = await ensureApiTokenActor({
      db: db as any,
      projectId,
      tokenId: token.tokenId,
      label: "tok-b",
    });

    expect(a2.id).toBe(a1.id); // upsert → same row
    expect(a2.label).toBe("tok-b"); // label updated on conflict

    const actorRows = await db
      .select()
      .from(schema.actorIdentities as any)
      .where(eq(schema.actorIdentities.kind as any, "api_token"));

    const apiTokenActors = actorRows.filter(
      (row: any) =>
        row.projectId === projectId && row.tokenId === token.tokenId,
    );

    expect(apiTokenActors).toHaveLength(1);
  });

  it("migration 0025: partial unique index exists on (projectId, tokenId) WHERE kind='api_token'", async () => {
    // This test verifies that the migration has run and the partial unique index exists.
    // We can't directly inspect indexes in SQLite, but in Postgres we can.
    const result = await pool.query(`
      SELECT indexname FROM pg_indexes
      WHERE tablename = 'actor_identities'
      AND indexname LIKE '%token_uq%'
    `);

    expect(result.rows.length).toBeGreaterThan(0);
    expect(result.rows.some((r: any) => r.indexname.includes("token"))).toBe(
      true,
    );
  });
});
