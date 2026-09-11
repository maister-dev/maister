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

// Route-level test: the recovery mechanics are proven by the ADR-034 suites and
// the state→HTTP contract by lib/runs/__tests__/recover-http.test.ts. Here the
// services are mocked so the assertions land on the EXT surface — scope
// enforcement, existence-hidden 404, audit rows, and outcome→status parity with
// the internal routes.
const { resumeCrashedRunMock, discardWorkbenchForTokenMock } = vi.hoisted(
  () => ({
    resumeCrashedRunMock: vi.fn(),
    discardWorkbenchForTokenMock: vi.fn(),
  }),
);

vi.mock("@/lib/runs/recover", () => ({
  resumeCrashedRun: resumeCrashedRunMock,
}));
vi.mock("@/lib/workbench-lifecycle/service", () => ({
  discardWorkbenchForToken: discardWorkbenchForTokenMock,
}));

let testDatabase: StartedPostgresTestDb;
let db: NodePgDatabase;

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

let recoverPOST: typeof import("@/app/api/v1/ext/runs/[runId]/recover/route").POST;
let discardPOST: typeof import("@/app/api/v1/ext/runs/[runId]/discard/route").POST;

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "ext_runs_recover_discard_test",
  });

  db = testDatabase.db;

  recoverPOST = (await import("@/app/api/v1/ext/runs/[runId]/recover/route"))
    .POST;
  discardPOST = (await import("@/app/api/v1/ext/runs/[runId]/discard/route"))
    .POST;
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

async function seedProject(slug: string) {
  const projectId = randomUUID();
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

  return { slug, projectId, executorId };
}

async function seedCrashedRun(projectId: string, executorId: string) {
  const runId = randomUUID();
  const workspaceId = randomUUID();

  await db.insert(schema.runs as any).values({
    id: runId,
    projectId,
    runnerId: executorId,
    capabilityAgent: "claude",
    runnerSnapshot: testRunnerSnapshot(executorId, "claude"),
    status: "Crashed",
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

function makeReq(runId: string, op: "recover" | "discard"): NextRequest {
  return new NextRequest(`http://localhost/api/v1/ext/runs/${runId}/${op}`, {
    method: "POST",
  });
}

function routeParams(runId: string) {
  return { params: Promise.resolve({ runId }) };
}

async function auditRows() {
  return db
    .select()
    .from(schema.tokenAuditLog as any)
    .execute();
}

beforeEach(async () => {
  await db.delete(schema.tokenAuditLog as any);
  resumeCrashedRunMock.mockReset();
  discardWorkbenchForTokenMock.mockReset();
  resumeCrashedRunMock.mockResolvedValue({ state: "resumed" });
  discardWorkbenchForTokenMock.mockResolvedValue({
    ok: true,
    runId: "r",
    operation: "discard",
    runStatus: "Abandoned",
    workspaceRemoved: true,
    idempotent: false,
    preservationOutcome: "archived",
    archivedBranch: "maister/archive/test",
  });
});

describe("POST /api/v1/ext/runs/[runId]/recover", () => {
  it("invalid token → 401, no audit row", async () => {
    const { projectId, executorId } = await seedProject(
      `ext-recover-401-${randomUUID().slice(0, 8)}`,
    );
    const runId = await seedCrashedRun(projectId, executorId);
    const req = makeReq(runId, "recover");

    req.headers.set("authorization", "Bearer invalid");

    const res = await recoverPOST(req, routeParams(runId));

    expect(res.status).toBe(401);
    expect(await auditRows()).toHaveLength(0);
    expect(resumeCrashedRunMock).not.toHaveBeenCalled();
  });

  it("token without runs:recover scope → 403, refusal audit row", async () => {
    const { projectId, executorId } = await seedProject(
      `ext-recover-403-${randomUUID().slice(0, 8)}`,
    );
    const runId = await seedCrashedRun(projectId, executorId);
    const token = await issueToken(
      { projectId, name: "read-only", scopes: ["runs:read"] },
      db,
    );
    const req = makeReq(runId, "recover");

    req.headers.set("authorization", `Bearer ${token.secret}`);

    const res = await recoverPOST(req, routeParams(runId));

    expect(res.status).toBe(403);
    expect(resumeCrashedRunMock).not.toHaveBeenCalled();

    const rows = await auditRows();

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      result: "error",
      status_code: 403,
      scope_used: "runs:recover",
    });
  });

  it("wrong-project runId → existence-hidden 404 before any recovery attempt", async () => {
    const { projectId: proj1 } = await seedProject(
      `ext-recover-x1-${randomUUID().slice(0, 8)}`,
    );
    const { projectId: proj2, executorId: exec2 } = await seedProject(
      `ext-recover-x2-${randomUUID().slice(0, 8)}`,
    );
    const runId = await seedCrashedRun(proj2, exec2);
    const token = await issueToken(
      { projectId: proj1, name: "proj1", scopes: ["runs:recover"] },
      db,
    );
    const req = makeReq(runId, "recover");

    req.headers.set("authorization", `Bearer ${token.secret}`);

    const res = await recoverPOST(req, routeParams(runId));

    expect(res.status).toBe(404);
    // `resumeCrashedRun` takes no projectId — the route's lookup is the only
    // thing keeping a project-A token off a project-B run.
    expect(resumeCrashedRunMock).not.toHaveBeenCalled();

    const rows = await auditRows();

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ result: "error", status_code: 404 });
  });

  it("unknown (non-UUID) runId → 404, never a database error", async () => {
    const { projectId } = await seedProject(
      `ext-recover-bad-${randomUUID().slice(0, 8)}`,
    );
    const token = await issueToken(
      { projectId, name: "ok", scopes: ["runs:recover"] },
      db,
    );
    const req = makeReq("not-a-uuid", "recover");

    req.headers.set("authorization", `Bearer ${token.secret}`);

    const res = await recoverPOST(req, routeParams("not-a-uuid"));

    expect(res.status).toBe(404);
    expect(resumeCrashedRunMock).not.toHaveBeenCalled();
  });

  it("resumed → 200 {ok, state, runStatus}, success audit row", async () => {
    const { projectId, executorId } = await seedProject(
      `ext-recover-ok-${randomUUID().slice(0, 8)}`,
    );
    const runId = await seedCrashedRun(projectId, executorId);
    const token = await issueToken(
      { projectId, name: "ok", scopes: ["runs:recover"] },
      db,
    );
    const req = makeReq(runId, "recover");

    req.headers.set("authorization", `Bearer ${token.secret}`);

    const res = await recoverPOST(req, routeParams(runId));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      state: "resumed",
      runStatus: "Running",
    });
    expect(resumeCrashedRunMock).toHaveBeenCalledWith(runId);

    const rows = await auditRows();

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      result: "ok",
      status_code: 200,
      scope_used: "runs:recover",
    });
  });

  it("cap-full queue → 202, matching the internal route", async () => {
    const { projectId, executorId } = await seedProject(
      `ext-recover-202-${randomUUID().slice(0, 8)}`,
    );
    const runId = await seedCrashedRun(projectId, executorId);
    const token = await issueToken(
      { projectId, name: "ok", scopes: ["runs:recover"] },
      db,
    );

    resumeCrashedRunMock.mockResolvedValue({ state: "queued" });

    const req = makeReq(runId, "recover");

    req.headers.set("authorization", `Bearer ${token.secret}`);

    const res = await recoverPOST(req, routeParams(runId));

    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({
      ok: true,
      state: "queued",
      runStatus: "Pending",
    });
  });

  it("discard-only → 409 CONFLICT that points the caller at discard", async () => {
    const { projectId, executorId } = await seedProject(
      `ext-recover-409-${randomUUID().slice(0, 8)}`,
    );
    const runId = await seedCrashedRun(projectId, executorId);
    const token = await issueToken(
      { projectId, name: "ok", scopes: ["runs:recover"] },
      db,
    );

    resumeCrashedRunMock.mockResolvedValue({ state: "discard-only" });

    const req = makeReq(runId, "recover");

    req.headers.set("authorization", `Bearer ${token.secret}`);

    const res = await recoverPOST(req, routeParams(runId));

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "CONFLICT" });

    const rows = await auditRows();

    expect(rows[0]).toMatchObject({ result: "error", status_code: 409 });
  });

  it("unresumable → 410 CHECKPOINT, not the generic ext 500 fallback", async () => {
    const { projectId, executorId } = await seedProject(
      `ext-recover-410-${randomUUID().slice(0, 8)}`,
    );
    const runId = await seedCrashedRun(projectId, executorId);
    const token = await issueToken(
      { projectId, name: "ok", scopes: ["runs:recover"] },
      db,
    );

    resumeCrashedRunMock.mockResolvedValue({ state: "unresumable" });

    const req = makeReq(runId, "recover");

    req.headers.set("authorization", `Bearer ${token.secret}`);

    const res = await recoverPOST(req, routeParams(runId));

    expect(res.status).toBe(410);
    expect(await res.json()).toMatchObject({ code: "CHECKPOINT" });
  });
});

describe("POST /api/v1/ext/runs/[runId]/discard", () => {
  it("token without runs:recover scope → 403, refusal audit row", async () => {
    const { projectId, executorId } = await seedProject(
      `ext-discard-403-${randomUUID().slice(0, 8)}`,
    );
    const runId = await seedCrashedRun(projectId, executorId);
    const token = await issueToken(
      { projectId, name: "launcher", scopes: ["runs:launch"] },
      db,
    );
    const req = makeReq(runId, "discard");

    req.headers.set("authorization", `Bearer ${token.secret}`);

    const res = await discardPOST(req, routeParams(runId));

    expect(res.status).toBe(403);
    expect(discardWorkbenchForTokenMock).not.toHaveBeenCalled();

    const rows = await auditRows();

    expect(rows[0]).toMatchObject({
      result: "error",
      status_code: 403,
      scope_used: "runs:recover",
    });
  });

  it("wrong-project runId → existence-hidden 404", async () => {
    const { projectId: proj1 } = await seedProject(
      `ext-discard-x1-${randomUUID().slice(0, 8)}`,
    );
    const { projectId: proj2, executorId: exec2 } = await seedProject(
      `ext-discard-x2-${randomUUID().slice(0, 8)}`,
    );
    const runId = await seedCrashedRun(proj2, exec2);
    const token = await issueToken(
      { projectId: proj1, name: "proj1", scopes: ["runs:recover"] },
      db,
    );
    const req = makeReq(runId, "discard");

    req.headers.set("authorization", `Bearer ${token.secret}`);

    const res = await discardPOST(req, routeParams(runId));

    expect(res.status).toBe(404);
    expect(discardWorkbenchForTokenMock).not.toHaveBeenCalled();
  });

  it("discards a Crashed run → 200 with the removal DTO, success audit row", async () => {
    const { projectId, executorId } = await seedProject(
      `ext-discard-ok-${randomUUID().slice(0, 8)}`,
    );
    const runId = await seedCrashedRun(projectId, executorId);
    const token = await issueToken(
      { projectId, name: "ok", scopes: ["runs:recover"] },
      db,
    );
    const req = makeReq(runId, "discard");

    req.headers.set("authorization", `Bearer ${token.secret}`);

    const res = await discardPOST(req, routeParams(runId));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      operation: "discard",
      runStatus: "Abandoned",
      workspaceRemoved: true,
    });
    expect(discardWorkbenchForTokenMock).toHaveBeenCalledWith(runId, {
      projectId,
    });

    const rows = await auditRows();

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      result: "ok",
      status_code: 200,
      scope_used: "runs:recover",
    });
  });

  it("policy refusal (live run) → typed 409, failure audit row", async () => {
    const { projectId, executorId } = await seedProject(
      `ext-discard-409-${randomUUID().slice(0, 8)}`,
    );
    const runId = await seedCrashedRun(projectId, executorId);
    const token = await issueToken(
      { projectId, name: "ok", scopes: ["runs:recover"] },
      db,
    );

    discardWorkbenchForTokenMock.mockRejectedValue(
      new MaisterError(
        "PRECONDITION",
        `workbench action drop is not allowed for run ${runId}: live-workbench`,
      ),
    );

    const req = makeReq(runId, "discard");

    req.headers.set("authorization", `Bearer ${token.secret}`);

    const res = await discardPOST(req, routeParams(runId));

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "PRECONDITION" });

    const rows = await auditRows();

    expect(rows[0]).toMatchObject({ result: "error", status_code: 409 });
  });
});
