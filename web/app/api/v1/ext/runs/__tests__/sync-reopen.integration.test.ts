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

import { MaisterError } from "@/lib/errors";
import { issueToken } from "@/lib/tokens/issue";
import {
  testPlatformRunnerRow,
  testRunnerSnapshot,
} from "@/lib/__tests__/runner-fixtures";
import * as schemaModule from "@/lib/db/schema";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const schema = schemaModule as unknown as Record<string, any>;

// Route-level test: the git mechanics of sync/reopen are proven by
// sync-target.integration.test.ts + reopen.integration.test.ts. Here the
// service functions are mocked so the assertions land on the EXT surface —
// scope enforcement, existence-hidden 404, body validation, audit rows, and
// outcome→status parity with the internal routes.
const { syncRunTargetMock, reopenRunMock, loadRunnerCatalogMock } = vi.hoisted(
  () => ({
    syncRunTargetMock: vi.fn(),
    reopenRunMock: vi.fn(),
    loadRunnerCatalogMock: vi.fn(),
  }),
);

vi.mock("@/lib/runs/sync-target", () => ({ syncRunTarget: syncRunTargetMock }));
vi.mock("@/lib/runs/reopen", () => ({ reopenRun: reopenRunMock }));
vi.mock("@/lib/acp-runners/catalog", () => ({
  loadRunnerCatalog: loadRunnerCatalogMock,
}));

let testDatabase: StartedPostgresTestDb;
let db: NodePgDatabase;

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

let syncPOST: typeof import("@/app/api/v1/ext/runs/sync/route").POST;
let reopenPOST: typeof import("@/app/api/v1/ext/runs/reopen/route").POST;

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "ext_runs_sync_reopen_test",
  });

  db = testDatabase.db;

  syncPOST = (await import("@/app/api/v1/ext/runs/sync/route")).POST;
  reopenPOST = (await import("@/app/api/v1/ext/runs/reopen/route")).POST;
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

async function seedProject(slug: string) {
  const projectId = randomUUID();
  const flowId = randomUUID();
  const executorId = randomUUID();

  await db.insert(schema.projects).values({
    taskKey: `T${randomUUID().slice(0, 8)}`.toUpperCase(),
    id: projectId,
    slug,
    name: `Project ${slug}`,
    repoPath: `/tmp/${slug}`,
    maisterYamlPath: `/tmp/${slug}/maister.yaml`,
  });

  await db
    .insert(schema.platformAcpRunners)
    .values(testPlatformRunnerRow(executorId, "claude"));

  return { slug, projectId, flowId, executorId };
}

async function seedReviewRun(projectId: string, executorId: string) {
  const runId = randomUUID();
  const workspaceId = randomUUID();

  await db.insert(schema.runs as any).values({
    id: runId,
    projectId,
    runnerId: executorId,
    capabilityAgent: "claude",
    runnerSnapshot: testRunnerSnapshot(executorId, "claude"),
    status: "Review",
    runKind: "flow",
    flowVersion: "v1.0.0",
  });

  await db.insert(schema.workspaces as any).values({
    id: workspaceId,
    projectId,
    runId,
    branch: "maister/test",
    worktreePath: `/tmp/wt-${runId}`,
    parentRepoPath: `/tmp/repo`,
  });

  return runId;
}

function makeReq(path: string, body: unknown): NextRequest {
  return new NextRequest(`http://localhost/api/v1/ext/runs/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function auditRows() {
  return db
    .select()
    .from(schema.tokenAuditLog as any)
    .execute();
}

beforeEach(async () => {
  await db.delete(schema.tokenAuditLog as any);
  syncRunTargetMock.mockReset();
  reopenRunMock.mockReset();
  loadRunnerCatalogMock.mockReset();
  syncRunTargetMock.mockResolvedValue({
    attemptId: "att-1",
    outcome: "synced",
    behind: 1,
    pushed: false,
  });
  reopenRunMock.mockResolvedValue({ status: "Review", worktreeRevived: false });
  loadRunnerCatalogMock.mockResolvedValue([]);
});

describe("POST /api/v1/ext/runs/sync", () => {
  it("missing/invalid token → 401, no audit row", async () => {
    const { projectId, executorId } = await seedProject(
      `ext-sync-401-${randomUUID().slice(0, 8)}`,
    );
    const runId = await seedReviewRun(projectId, executorId);
    const req = makeReq("sync", { runId });

    req.headers.set("authorization", "Bearer invalid");

    const res = await syncPOST(req);

    expect(res.status).toBe(401);
    expect(await auditRows()).toHaveLength(0);
    expect(syncRunTargetMock).not.toHaveBeenCalled();
  });

  it("token without runs:sync scope → 403, refusal audit row", async () => {
    const { projectId, executorId } = await seedProject(
      `ext-sync-403-${randomUUID().slice(0, 8)}`,
    );
    const runId = await seedReviewRun(projectId, executorId);
    const token = await issueToken(
      { projectId, name: "read-only", scopes: ["runs:read"] },
      db,
    );
    const req = makeReq("sync", { runId });

    req.headers.set("authorization", `Bearer ${token.secret}`);

    const res = await syncPOST(req);

    expect(res.status).toBe(403);
    expect(syncRunTargetMock).not.toHaveBeenCalled();

    const rows = await auditRows();

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      result: "error",
      status_code: 403,
      scope_used: "runs:sync",
    });
  });

  it("wrong-project runId → existence-hidden 404, audit row", async () => {
    const { projectId: proj1 } = await seedProject(
      `ext-sync-x1-${randomUUID().slice(0, 8)}`,
    );
    const { projectId: proj2, executorId: exec2 } = await seedProject(
      `ext-sync-x2-${randomUUID().slice(0, 8)}`,
    );
    const runId = await seedReviewRun(proj2, exec2);
    const token = await issueToken(
      { projectId: proj1, name: "proj1", scopes: ["runs:sync"] },
      db,
    );
    const req = makeReq("sync", { runId });

    req.headers.set("authorization", `Bearer ${token.secret}`);

    const res = await syncPOST(req);

    expect(res.status).toBe(404);
    expect(syncRunTargetMock).not.toHaveBeenCalled();

    const rows = await auditRows();

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ result: "error", status_code: 404 });
  });

  it("malformed body (missing runId) → 422", async () => {
    const { projectId, executorId } = await seedProject(
      `ext-sync-422-${randomUUID().slice(0, 8)}`,
    );

    await seedReviewRun(projectId, executorId);

    const token = await issueToken(
      { projectId, name: "ok", scopes: ["runs:sync"] },
      db,
    );
    const req = makeReq("sync", { strategy: "rebase" });

    req.headers.set("authorization", `Bearer ${token.secret}`);

    const res = await syncPOST(req);

    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe("CONFIG");
  });

  it("unknown runnerId → 422, audit row", async () => {
    const { projectId, executorId } = await seedProject(
      `ext-sync-runner-${randomUUID().slice(0, 8)}`,
    );
    const runId = await seedReviewRun(projectId, executorId);
    const token = await issueToken(
      { projectId, name: "ok", scopes: ["runs:sync"] },
      db,
    );

    loadRunnerCatalogMock.mockResolvedValue([{ id: "some-other-runner" }]);

    const req = makeReq("sync", { runId, runnerId: "nope" });

    req.headers.set("authorization", `Bearer ${token.secret}`);

    const res = await syncPOST(req);

    expect(res.status).toBe(422);
    expect(syncRunTargetMock).not.toHaveBeenCalled();
  });

  it("synced outcome → 200 body parity + success audit row", async () => {
    const { projectId, executorId } = await seedProject(
      `ext-sync-ok-${randomUUID().slice(0, 8)}`,
    );
    const runId = await seedReviewRun(projectId, executorId);
    const token = await issueToken(
      { projectId, name: "ok", scopes: ["runs:sync"] },
      db,
    );
    const req = makeReq("sync", { runId, strategy: "rebase" });

    req.headers.set("authorization", `Bearer ${token.secret}`);

    const res = await syncPOST(req);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      runId,
      attemptId: "att-1",
      outcome: "synced",
      behind: 1,
      pushed: false,
    });

    const call = syncRunTargetMock.mock.calls[0][0];

    expect(call).toMatchObject({
      runId,
      strategy: "rebase",
      actor: { type: "user" },
    });

    const rows = await auditRows();

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      result: "ok",
      status_code: 200,
      scope_used: "runs:sync",
    });
  });

  it("agent_launched outcome → 202 (resolver session started)", async () => {
    const { projectId, executorId } = await seedProject(
      `ext-sync-202-${randomUUID().slice(0, 8)}`,
    );
    const runId = await seedReviewRun(projectId, executorId);
    const token = await issueToken(
      { projectId, name: "ok", scopes: ["runs:sync"] },
      db,
    );

    syncRunTargetMock.mockResolvedValue({
      attemptId: "att-2",
      outcome: "agent_launched",
      behind: 2,
      pushed: false,
    });

    const req = makeReq("sync", { runId });

    req.headers.set("authorization", `Bearer ${token.secret}`);

    const res = await syncPOST(req);

    expect(res.status).toBe(202);
    expect((await res.json()).outcome).toBe("agent_launched");
  });

  it("domain CONFLICT → 409 (parity with internal typed status)", async () => {
    const { projectId, executorId } = await seedProject(
      `ext-sync-409-${randomUUID().slice(0, 8)}`,
    );
    const runId = await seedReviewRun(projectId, executorId);
    const token = await issueToken(
      { projectId, name: "ok", scopes: ["runs:sync"] },
      db,
    );

    syncRunTargetMock.mockRejectedValue(
      new MaisterError("CONFLICT", "lease rejected"),
    );

    const req = makeReq("sync", { runId });

    req.headers.set("authorization", `Bearer ${token.secret}`);

    const res = await syncPOST(req);

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("CONFLICT");
  });

  it("EXECUTOR_UNAVAILABLE → 503", async () => {
    const { projectId, executorId } = await seedProject(
      `ext-sync-503-${randomUUID().slice(0, 8)}`,
    );
    const runId = await seedReviewRun(projectId, executorId);
    const token = await issueToken(
      { projectId, name: "ok", scopes: ["runs:sync"] },
      db,
    );

    syncRunTargetMock.mockRejectedValue(
      new MaisterError("EXECUTOR_UNAVAILABLE", "supervisor down"),
    );

    const req = makeReq("sync", { runId });

    req.headers.set("authorization", `Bearer ${token.secret}`);

    const res = await syncPOST(req);

    expect(res.status).toBe(503);
  });
});

describe("POST /api/v1/ext/runs/reopen", () => {
  it("token without runs:sync scope → 403, refusal audit row", async () => {
    const { projectId, executorId } = await seedProject(
      `ext-reopen-403-${randomUUID().slice(0, 8)}`,
    );
    const runId = await seedReviewRun(projectId, executorId);
    const token = await issueToken(
      { projectId, name: "read-only", scopes: ["runs:read"] },
      db,
    );
    const req = makeReq("reopen", { runId });

    req.headers.set("authorization", `Bearer ${token.secret}`);

    const res = await reopenPOST(req);

    expect(res.status).toBe(403);
    expect(reopenRunMock).not.toHaveBeenCalled();

    const rows = await auditRows();

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      result: "error",
      status_code: 403,
      scope_used: "runs:sync",
    });
  });

  it("wrong-project runId → existence-hidden 404", async () => {
    const { projectId: proj1 } = await seedProject(
      `ext-reopen-x1-${randomUUID().slice(0, 8)}`,
    );
    const { projectId: proj2, executorId: exec2 } = await seedProject(
      `ext-reopen-x2-${randomUUID().slice(0, 8)}`,
    );
    const runId = await seedReviewRun(proj2, exec2);
    const token = await issueToken(
      { projectId: proj1, name: "proj1", scopes: ["runs:sync"] },
      db,
    );
    const req = makeReq("reopen", { runId });

    req.headers.set("authorization", `Bearer ${token.secret}`);

    const res = await reopenPOST(req);

    expect(res.status).toBe(404);
    expect(reopenRunMock).not.toHaveBeenCalled();
  });

  it("reopened → 200 {runId, status:Review} + success audit row", async () => {
    const { projectId, executorId } = await seedProject(
      `ext-reopen-ok-${randomUUID().slice(0, 8)}`,
    );
    const runId = await seedReviewRun(projectId, executorId);
    const token = await issueToken(
      { projectId, name: "ok", scopes: ["runs:sync"] },
      db,
    );
    const req = makeReq("reopen", { runId });

    req.headers.set("authorization", `Bearer ${token.secret}`);

    const res = await reopenPOST(req);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ runId, status: "Review" });

    const rows = await auditRows();

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      result: "ok",
      status_code: 200,
      scope_used: "runs:sync",
    });
  });

  it("domain PRECONDITION (not eligible) → 409", async () => {
    const { projectId, executorId } = await seedProject(
      `ext-reopen-409-${randomUUID().slice(0, 8)}`,
    );
    const runId = await seedReviewRun(projectId, executorId);
    const token = await issueToken(
      { projectId, name: "ok", scopes: ["runs:sync"] },
      db,
    );

    reopenRunMock.mockRejectedValue(
      new MaisterError("PRECONDITION", "run is not Done"),
    );

    const req = makeReq("reopen", { runId });

    req.headers.set("authorization", `Bearer ${token.secret}`);

    const res = await reopenPOST(req);

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("PRECONDITION");
  });
});
