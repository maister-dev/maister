// RED (M16 Phase 4 §D): POST /api/v1/ext/runs/{runId}/gates/{gateId}/report.
//
// Derived from the FROZEN spec:
//   - docs/api/external/operations.openapi.yaml lines 336-395 (route) and
//     684-733 (ExtGateReportBody / ExtGateReportResponse).
//   - docs/system-analytics/external-operations.md §"Gate-report" sequence,
//     §Expectations, §Edge cases.
//
// The route module does NOT exist yet
// (app/api/v1/ext/runs/[runId]/gates/[gateId]/report/route.ts) — the dynamic
// import in beforeAll fails, which is a valid RED state for every test here.
//
// Mirrors the sibling ext-route harness: testcontainers Postgres + migrate +
// vi.mock("@/lib/db/client") to inject the test DB + dynamic import of the route
// AFTER the mock + issueToken + seedProject. Auth failure / cross-project /
// unknown-gate / invalid-body / success + audit semantics are asserted against
// real DB rows. The atomic-rollback test lives in a sibling *.atomic file
// because it needs a module-level vi.mock of the audit insert.

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
import {
  testPlatformRunnerRow,
  testRunnerSnapshot,
} from "@/lib/__tests__/runner-fixtures";
import * as schemaModule from "@/lib/db/schema";

const schema = schemaModule as unknown as Record<string, any>;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;
let originalDbUrl: string | undefined;

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

let POST: typeof import("@/app/api/v1/ext/runs/[runId]/gates/[gateId]/report/route").POST;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("ext_gate_report_route_test")
    .withUsername("test")
    .withPassword("test")
    .start();

  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);

  // The route gates its concurrency row-lock (`SELECT ... FOR UPDATE`) on
  // isPostgres() reading DB_URL — point it at the container so the lock engages.
  // Capture the prior value first so afterAll restores it instead of unsetting
  // a DB_URL the surrounding process/worker may have relied on.
  originalDbUrl = process.env.DB_URL;
  process.env.DB_URL = container.getConnectionUri();

  await migrate(db, { migrationsFolder: "./lib/db/migrations" });
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();

  if (originalDbUrl === undefined) {
    delete process.env.DB_URL;
  } else {
    process.env.DB_URL = originalDbUrl;
  }
});

beforeAll(async () => {
  const routeModule = await import(
    "@/app/api/v1/ext/runs/[runId]/gates/[gateId]/report/route"
  );

  POST = routeModule.POST;
});

async function seedProject(slug: string) {
  const projectId = randomUUID();
  const flowId = randomUUID();
  const executorId = randomUUID();

  await db.insert(schema.projects).values({
    id: projectId,
    slug,
    name: `Project ${slug}`,
    repoPath: `/tmp/${slug}`,
    maisterYamlPath: `/tmp/${slug}/maister.yaml`,
  });
  await db.insert(schema.flows).values({
    id: flowId,
    projectId,
    flowRefId: "bugfix",
    source: "github.com/x/y",
    version: "v1.0.0",
    installedPath: "/tmp/flows/bugfix",
    manifest: { schemaVersion: 1, name: "Bugfix", steps: [] },
    schemaVersion: 1,
  });
  await db
    .insert(schema.platformAcpRunners)
    .values(testPlatformRunnerRow(executorId, "claude"));

  return { slug, projectId, flowId, executorId };
}

async function seedTask(projectId: string, flowId: string) {
  const taskId = randomUUID();

  await db.insert(schema.tasks as any).values({
    id: taskId,
    projectId,
    title: "Test Task",
    prompt: "Do something",
    flowId,
    status: "InFlight",
    stage: "InFlight",
    attemptNumber: 1,
  });

  return taskId;
}

async function seedRun(
  projectId: string,
  taskId: string,
  flowId: string,
  executorId: string,
) {
  const runId = randomUUID();
  const workspaceId = randomUUID();

  await db.insert(schema.runs as any).values({
    id: runId,
    taskId,
    projectId,
    flowId,
    runnerId: executorId,
    capabilityAgent: "claude",
    runnerSnapshot: testRunnerSnapshot(executorId, "claude"),
    status: "Running",
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

// Seed a live external_check gate (pending) on a node attempt. Returns gateId
// (manifest gate id) + the gate_results row id.
async function seedExternalGate(
  runId: string,
  gateId: string,
  opts: { kind?: string; status?: string; verdict?: unknown } = {},
): Promise<{ gateResultId: string }> {
  const nodeAttemptId = randomUUID();

  await db.insert(schema.nodeAttempts as any).values({
    id: nodeAttemptId,
    runId,
    nodeId: "review",
    nodeType: "check",
    attempt: 1,
    status: "Succeeded",
    startedAt: new Date("2026-06-02T10:00:00.000Z"),
  });

  const gateResultId = randomUUID();

  await db.insert(schema.gateResults as any).values({
    id: gateResultId,
    runId,
    nodeAttemptId,
    gateId,
    kind: opts.kind ?? "external_check",
    mode: "blocking",
    status: opts.status ?? "pending",
    verdict: opts.verdict ?? null,
  });

  return { gateResultId };
}

async function externalGateRows(runId: string): Promise<any[]> {
  const rows = (await db
    .select()
    .from(schema.gateResults as any)
    .where(eq(schema.gateResults.runId, runId))) as unknown as any[];

  return rows.filter((r) => r.kind === "external_check");
}

function makeRequest(
  runId: string,
  gateId: string,
  body: unknown,
  bearer?: string,
): NextRequest {
  const req = new NextRequest(
    `http://localhost/api/v1/ext/runs/${runId}/gates/${gateId}/report`,
    {
      method: "POST",
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: { "content-type": "application/json" },
    },
  );

  if (bearer) req.headers.set("authorization", `Bearer ${bearer}`);

  return req;
}

function ctx(runId: string, gateId: string) {
  return { params: Promise.resolve({ runId, gateId }) };
}

async function auditRows() {
  return db
    .select()
    .from(schema.tokenAuditLog as any)
    .execute();
}

async function getGate(gateResultId: string) {
  const rows = (await db
    .select()
    .from(schema.gateResults as any)
    .where(eq(schema.gateResults.id, gateResultId))) as unknown as any[];

  return rows[0];
}

async function getRun(runId: string) {
  const rows = (await db
    .select()
    .from(schema.runs as any)
    .where(eq(schema.runs.id, runId))) as unknown as any[];

  return rows[0];
}

// Poll until the in-flight report request is blocked on a row lock while running
// its gate-row UPDATE. Lets a test commit a concurrent gate writer only AFTER
// the report has passed its live-row SELECT and is parked at its CAS write —
// landing the conflicting change inside the SELECT→write window deterministically.
async function waitForReportBlockedOnGateLock(): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt++) {
    const { rows } = await pool.query(
      `SELECT 1
         FROM pg_stat_activity
        WHERE state = 'active'
          AND wait_event_type = 'Lock'
          AND query ILIKE '%gate_results%'
          AND query ILIKE '%update%'`,
    );

    if (rows.length > 0) return;

    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error("report did not block on the gate-row lock within timeout");
}

async function getArtifacts(runId: string) {
  return (await db
    .select()
    .from(schema.artifactInstances as any)
    .where(eq(schema.artifactInstances.runId, runId))) as unknown as any[];
}

beforeEach(async () => {
  await db.delete(schema.tokenAuditLog as any);
});

describe("POST /api/v1/ext/runs/[runId]/gates/[gateId]/report (M16 §D)", () => {
  it("missing/unrecognized token → 401, NO audit row", async () => {
    const { projectId, flowId, executorId } = await seedProject(
      `gr-noauth-${randomUUID().slice(0, 8)}`,
    );
    const taskId = await seedTask(projectId, flowId);
    const runId = await seedRun(projectId, taskId, flowId, executorId);

    await seedExternalGate(runId, "ci");

    const req = makeRequest(
      runId,
      "ci",
      { status: "passed" },
      "totally-invalid",
    );
    const res = await POST(req, ctx(runId, "ci"));

    expect(res.status).toBe(401);
    expect(await auditRows()).toHaveLength(0);
  });

  it("identified-but-revoked token → 401 + failure audit row", async () => {
    const { projectId, flowId, executorId } = await seedProject(
      `gr-revoked-${randomUUID().slice(0, 8)}`,
    );
    const taskId = await seedTask(projectId, flowId);
    const runId = await seedRun(projectId, taskId, flowId, executorId);

    await seedExternalGate(runId, "ci");

    const token = await issueToken({ projectId, name: "to-revoke" }, db);

    await db
      .update(schema.projectTokens as any)
      .set({ revoked_at: new Date() })
      .where(eq(schema.projectTokens.id, token.tokenId));

    const req = makeRequest(runId, "ci", { status: "passed" }, token.secret);
    const res = await POST(req, ctx(runId, "ci"));

    expect(res.status).toBe(401);

    const rows = await auditRows();

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ result: "error", status_code: 401 });
  });

  it("cross-project token → 404 + failure audit; no gate/artifact mutation", async () => {
    const { projectId: proj1 } = await seedProject(
      `gr-x1-${randomUUID().slice(0, 8)}`,
    );
    const {
      projectId: proj2,
      flowId: flow2,
      executorId: exec2,
    } = await seedProject(`gr-x2-${randomUUID().slice(0, 8)}`);

    const taskId = await seedTask(proj2, flow2);
    const runId = await seedRun(proj2, taskId, flow2, exec2);
    const { gateResultId } = await seedExternalGate(runId, "ci");

    const token = await issueToken({ projectId: proj1, name: "proj1" }, db);

    const req = makeRequest(runId, "ci", { status: "passed" }, token.secret);
    const res = await POST(req, ctx(runId, "ci"));

    expect(res.status).toBe(404);

    const rows = await auditRows();

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      result: "error",
      status_code: 404,
      scope_used: "gates:report",
    });

    // No mutation: gate still pending, no test_report artifact.
    expect((await getGate(gateResultId)).status).toBe("pending");
    expect(
      (await getArtifacts(runId)).filter((a) => a.kind === "test_report"),
    ).toHaveLength(0);
  });

  it("unknown gateId → 404 + failure audit; no mutation", async () => {
    const { projectId, flowId, executorId } = await seedProject(
      `gr-unknown-${randomUUID().slice(0, 8)}`,
    );
    const taskId = await seedTask(projectId, flowId);
    const runId = await seedRun(projectId, taskId, flowId, executorId);

    await seedExternalGate(runId, "ci");

    const token = await issueToken({ projectId, name: "ok" }, db);

    const req = makeRequest(
      runId,
      "does-not-exist",
      { status: "passed" },
      token.secret,
    );
    const res = await POST(req, ctx(runId, "does-not-exist"));

    expect(res.status).toBe(404);

    const rows = await auditRows();

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ result: "error", status_code: 404 });
  });

  it("non-external gate kind → 404 + failure audit; no mutation", async () => {
    const { projectId, flowId, executorId } = await seedProject(
      `gr-nonext-${randomUUID().slice(0, 8)}`,
    );
    const taskId = await seedTask(projectId, flowId);
    const runId = await seedRun(projectId, taskId, flowId, executorId);

    // A command_check gate is NOT reportable via this endpoint.
    const { gateResultId } = await seedExternalGate(runId, "fmt", {
      kind: "command_check",
      status: "passed",
    });

    const token = await issueToken({ projectId, name: "ok" }, db);

    const req = makeRequest(runId, "fmt", { status: "passed" }, token.secret);
    const res = await POST(req, ctx(runId, "fmt"));

    expect(res.status).toBe(404);
    expect((await getGate(gateResultId)).status).toBe("passed"); // untouched

    const rows = await auditRows();

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ result: "error", status_code: 404 });
  });

  it("already-overridden gate (sealed) → 404 + failure audit; no mutation", async () => {
    const { projectId, flowId, executorId } = await seedProject(
      `gr-sealed-${randomUUID().slice(0, 8)}`,
    );
    const taskId = await seedTask(projectId, flowId);
    const runId = await seedRun(projectId, taskId, flowId, executorId);
    const { gateResultId } = await seedExternalGate(runId, "ci", {
      status: "overridden",
    });

    const token = await issueToken({ projectId, name: "ok" }, db);

    const req = makeRequest(runId, "ci", { status: "passed" }, token.secret);
    const res = await POST(req, ctx(runId, "ci"));

    expect(res.status).toBe(404);
    expect((await getGate(gateResultId)).status).toBe("overridden");

    const rows = await auditRows();

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ result: "error", status_code: 404 });
  });

  it("invalid body (missing status) → 422 + failure audit; no mutation", async () => {
    const { projectId, flowId, executorId } = await seedProject(
      `gr-nobody-${randomUUID().slice(0, 8)}`,
    );
    const taskId = await seedTask(projectId, flowId);
    const runId = await seedRun(projectId, taskId, flowId, executorId);
    const { gateResultId } = await seedExternalGate(runId, "ci");

    const token = await issueToken({ projectId, name: "ok" }, db);

    const req = makeRequest(
      runId,
      "ci",
      { summary: "no status here" },
      token.secret,
    );
    const res = await POST(req, ctx(runId, "ci"));

    expect(res.status).toBe(422);
    expect((await getGate(gateResultId)).status).toBe("pending");

    const rows = await auditRows();

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ result: "error", status_code: 422 });
  });

  it("invalid body (status not in enum) → 422 + failure audit", async () => {
    const { projectId, flowId, executorId } = await seedProject(
      `gr-badstatus-${randomUUID().slice(0, 8)}`,
    );
    const taskId = await seedTask(projectId, flowId);
    const runId = await seedRun(projectId, taskId, flowId, executorId);

    await seedExternalGate(runId, "ci");

    const token = await issueToken({ projectId, name: "ok" }, db);

    const req = makeRequest(runId, "ci", { status: "pending" }, token.secret);
    const res = await POST(req, ctx(runId, "ci"));

    expect(res.status).toBe(422);

    const rows = await auditRows();

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ result: "error", status_code: 422 });
  });

  it("success (status passed) → 200, gate flipped, test_report artifact, success audit", async () => {
    const { projectId, flowId, executorId } = await seedProject(
      `gr-ok-${randomUUID().slice(0, 8)}`,
    );
    const taskId = await seedTask(projectId, flowId);
    const runId = await seedRun(projectId, taskId, flowId, executorId);
    const { gateResultId } = await seedExternalGate(runId, "ci");

    const token = await issueToken({ projectId, name: "ok" }, db);

    const req = makeRequest(
      runId,
      "ci",
      {
        status: "passed",
        externalRunUrl: "https://ci.example/run/9",
        commitSha: "abc123",
        summary: "42 passed",
        payload: { passed: 42, failed: 0 },
      },
      token.secret,
    );
    const res = await POST(req, ctx(runId, "ci"));

    expect(res.status).toBe(200);

    const body = await res.json();

    expect(body).toMatchObject({ gateId: "ci", status: "passed" });
    expect(typeof body.artifactId).toBe("string");

    // Gate flipped.
    expect((await getGate(gateResultId)).status).toBe("passed");

    // test_report artifact recorded (producer 'gate').
    const reports = (await getArtifacts(runId)).filter(
      (a) => a.kind === "test_report",
    );

    expect(reports).toHaveLength(1);
    expect(reports[0].producer).toBe("gate");
    expect(reports[0].id).toBe(body.artifactId);

    // Success audit row inside the same flow.
    const rows = await auditRows();

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      result: "ok",
      status_code: 200,
      scope_used: "gates:report",
    });
  });

  it("success (status failed) → 200, gate flipped to failed", async () => {
    const { projectId, flowId, executorId } = await seedProject(
      `gr-fail-${randomUUID().slice(0, 8)}`,
    );
    const taskId = await seedTask(projectId, flowId);
    const runId = await seedRun(projectId, taskId, flowId, executorId);
    const { gateResultId } = await seedExternalGate(runId, "ci");

    const token = await issueToken({ projectId, name: "ok" }, db);

    const req = makeRequest(
      runId,
      "ci",
      { status: "failed", commitSha: "dead" },
      token.secret,
    );
    const res = await POST(req, ctx(runId, "ci"));

    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("failed");
    expect((await getGate(gateResultId)).status).toBe("failed");
  });

  it("terminal run (Done) → 409 CONFLICT, gate untouched, failure audit", async () => {
    const { projectId, flowId, executorId } = await seedProject(
      `gr-terminal-${randomUUID().slice(0, 8)}`,
    );
    const taskId = await seedTask(projectId, flowId);
    const runId = await seedRun(projectId, taskId, flowId, executorId);

    // seedRun forces "Running"; flip to a terminal status for this case.
    await db
      .update(schema.runs as any)
      .set({ status: "Done" })
      .where(eq(schema.runs.id, runId));

    const { gateResultId } = await seedExternalGate(runId, "ci");
    const token = await issueToken({ projectId, name: "ok" }, db);

    const req = makeRequest(runId, "ci", { status: "passed" }, token.secret);
    const res = await POST(req, ctx(runId, "ci"));

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("CONFLICT");
    expect((await getGate(gateResultId)).status).toBe("pending"); // untouched

    const rows = await auditRows();

    expect(rows[0]).toMatchObject({ result: "error", status_code: 409 });
  });

  it("run finalizes AFTER the pre-check but BEFORE the lock → 409, gate untouched, no artifact (TOCTOU)", async () => {
    const { projectId, flowId, executorId } = await seedProject(
      `gr-toctou-${randomUUID().slice(0, 8)}`,
    );
    const taskId = await seedTask(projectId, flowId);
    const runId = await seedRun(projectId, taskId, flowId, executorId);
    const { gateResultId } = await seedExternalGate(runId, "ci");

    const token = await issueToken({ projectId, name: "ok" }, db);

    // The run is live (Running) when the route runs its pre-check, then
    // finalizes before the report transaction takes the run-row lock. Injecting
    // the flip in the db.transaction seam lands it precisely in that window —
    // after the pre-check SELECT, before the locked re-read — so this exercises
    // the in-transaction guard, not the fast-path pre-check.
    const realTransaction = db.transaction.bind(db);
    const spy = vi.spyOn(db, "transaction");

    spy.mockImplementationOnce((async (cb: any) => {
      await db
        .update(schema.runs as any)
        .set({ status: "Done" })
        .where(eq(schema.runs.id, runId));

      return realTransaction(cb);
    }) as any);

    try {
      const req = makeRequest(runId, "ci", { status: "passed" }, token.secret);
      const res = await POST(req, ctx(runId, "ci"));

      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe("CONFLICT");

      // The locked re-read rejected the report: gate untouched, no artifact.
      expect((await getGate(gateResultId)).status).toBe("pending");
      expect(
        (await getArtifacts(runId)).filter((a) => a.kind === "test_report"),
      ).toHaveLength(0);

      const rows = await auditRows();

      expect(rows[0]).toMatchObject({ result: "error", status_code: 409 });
    } finally {
      spy.mockRestore();
    }
  });

  it("genuine concurrent finalize + report: serialized on the run row, never writes a gate on a terminal run", async () => {
    const { projectId, flowId, executorId } = await seedProject(
      `gr-genrace-${randomUUID().slice(0, 8)}`,
    );
    const taskId = await seedTask(projectId, flowId);
    const runId = await seedRun(projectId, taskId, flowId, executorId);
    const { gateResultId } = await seedExternalGate(runId, "ci");

    const token = await issueToken({ projectId, name: "ok" }, db);

    // Fire a run-finalizing UPDATE and the gate report at the same time. The
    // report's `SELECT ... FOR UPDATE` on the run row and the finalizing UPDATE
    // contend for the same row lock, so exactly two interleavings are legal:
    //   - report acquires the lock first → it re-reads `Running` under the lock,
    //     writes the gate, returns 200; the finalize then applies.
    //   - finalize acquires the lock first → report re-reads `Done` (under the
    //     lock or in the pre-check) → 409, no gate/artifact write.
    // No interleaving writes a gate on an already-terminal run.
    const [, res] = await Promise.all([
      db
        .update(schema.runs as any)
        .set({ status: "Done" })
        .where(eq(schema.runs.id, runId)),
      POST(
        makeRequest(runId, "ci", { status: "passed" }, token.secret),
        ctx(runId, "ci"),
      ),
    ]);

    expect([200, 409]).toContain(res.status);

    const gate = await getGate(gateResultId);
    const reports = (await getArtifacts(runId)).filter(
      (a) => a.kind === "test_report",
    );

    if (res.status === 200) {
      // Report won the lock first — gate written while the run was still live.
      expect(gate.status).toBe("passed");
      expect(reports).toHaveLength(1);
    } else {
      // Finalize won — the gate was never touched.
      expect((await res.json()).code).toBe("CONFLICT");
      expect(gate.status).toBe("pending");
      expect(reports).toHaveLength(0);
    }

    // Either way the finalize lands: the run is terminal at rest.
    expect((await getRun(runId)).status).toBe("Done");
  });

  it("concurrent reports for the SAME new commit serialize → one fresh row (no duplicate supersede)", async () => {
    const { projectId, flowId, executorId } = await seedProject(
      `gr-race-${randomUUID().slice(0, 8)}`,
    );
    const taskId = await seedTask(projectId, flowId);
    const runId = await seedRun(projectId, taskId, flowId, executorId);

    // A previously-passed external_check on commit "old".
    await seedExternalGate(runId, "ci", {
      status: "passed",
      verdict: { commitSha: "old" },
    });

    const token = await issueToken({ projectId, name: "ok" }, db);

    // Two concurrent reports for the SAME new commit. Without the run-row lock
    // both take the supersede branch and append TWO fresh rows; the lock
    // serializes them so the second updates the first's fresh row in place.
    const [resA, resB] = await Promise.all([
      POST(
        makeRequest(
          runId,
          "ci",
          { status: "passed", commitSha: "new" },
          token.secret,
        ),
        ctx(runId, "ci"),
      ),
      POST(
        makeRequest(
          runId,
          "ci",
          { status: "passed", commitSha: "new" },
          token.secret,
        ),
        ctx(runId, "ci"),
      ),
    ]);

    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);

    const rows = await externalGateRows(runId);

    // Old row re-staled + exactly ONE fresh passed row — never two fresh rows.
    expect(rows.filter((r) => r.status === "passed")).toHaveLength(1);
    expect(rows.filter((r) => r.status === "stale")).toHaveLength(1);
    expect(rows).toHaveLength(2);
  });

  // A gate-state writer that takes NO run-row lock (HITL override → `overridden`,
  // rework → `stale`) can change the live gate row between the report's live-row
  // SELECT and its write. The route's run `FOR UPDATE` only serializes
  // report-vs-report, so the gate-row CAS is what must reject the report.
  it.each(["overridden", "stale"] as const)(
    "report racing with a non-run-locking gate writer (%s) cannot restore the invalidated gate",
    async (blockerStatus) => {
      const { projectId, flowId, executorId } = await seedProject(
        `gr-gaterace-${randomUUID().slice(0, 8)}`,
      );
      const taskId = await seedTask(projectId, flowId);
      const runId = await seedRun(projectId, taskId, flowId, executorId);
      const { gateResultId } = await seedExternalGate(runId, "ci");

      const token = await issueToken({ projectId, name: "ok" }, db);

      // Hold the conflicting write uncommitted on a separate connection: the
      // report's live-row SELECT still sees `pending`, then the report parks on
      // this row lock at its CAS write. Committing after the report is blocked
      // lands the change squarely in the SELECT→write window.
      const blockerClient = await pool.connect();

      try {
        const blockerDb = drizzle(blockerClient);

        await blockerClient.query("BEGIN");
        await blockerDb
          .update(schema.gateResults as any)
          .set({ status: blockerStatus })
          .where(eq(schema.gateResults.id, gateResultId));

        const reportPromise = POST(
          makeRequest(runId, "ci", { status: "passed" }, token.secret),
          ctx(runId, "ci"),
        );

        await waitForReportBlockedOnGateLock();
        await blockerClient.query("COMMIT");

        const res = await reportPromise;

        // CAS saw the row change out from under the report → rejected with no
        // gate/artifact mutation. The invalidated/sealed gate is NOT restored.
        expect([404, 409]).toContain(res.status);
        expect((await getGate(gateResultId)).status).toBe(blockerStatus);
        expect(
          (await externalGateRows(runId)).filter(
            (r) => r.status === "passed" || r.status === "failed",
          ),
        ).toHaveLength(0);
        expect(
          (await getArtifacts(runId)).filter((a) => a.kind === "test_report"),
        ).toHaveLength(0);
      } finally {
        blockerClient.release();
      }
    },
  );

  it("uses the run's PINNED flow_revisions.manifest (not the mutable flows.manifest) for external gate config — upgrade/rollback drift", async () => {
    const { projectId, flowId, executorId } = await seedProject(
      `gr-pinned-${randomUUID().slice(0, 8)}`,
    );
    const taskId = await seedTask(projectId, flowId);
    const runId = await seedRun(projectId, taskId, flowId, executorId);

    // Pin the run to a flow_revisions snapshot whose manifest declares the `ci`
    // gate with external.staleOnNewCommit=false (the run launched against this).
    const revisionId = randomUUID();

    await (db as any).insert(schema.flowRevisions).values({
      id: revisionId,
      flowRefId: "bugfix",
      source: "github.com/x/y",
      versionLabel: "v1.0.0",
      resolvedRevision: `rev-${revisionId}`,
      manifestDigest: `sha256-${revisionId}`,
      installedPath: "/tmp/flows/bugfix",
      manifest: {
        schemaVersion: 1,
        name: "Bugfix",
        nodes: [
          {
            id: "review",
            pre_finish: {
              gates: [{ id: "ci", external: { staleOnNewCommit: false } }],
            },
          },
        ],
      },
      schemaVersion: 1,
      packageStatus: "Installed",
      setupStatus: "done",
    });

    await (db as any)
      .update(schema.runs)
      .set({ flowRevisionId: revisionId })
      .where(eq(schema.runs.id, runId));

    // Simulate a Flow upgrade AFTER launch: the live flows.manifest now declares
    // the SAME gate WITHOUT the opt-out (staleOnNewCommit default true). The
    // pinned revision must win — the mutated flows.manifest must be ignored.
    await (db as any)
      .update(schema.flows)
      .set({
        manifest: {
          schemaVersion: 1,
          name: "Bugfix",
          nodes: [
            {
              id: "review",
              pre_finish: {
                gates: [{ id: "ci", external: { staleOnNewCommit: true } }],
              },
            },
          ],
        },
      })
      .where(eq(schema.flows.id, flowId));

    // A previously-passed external_check on commit "old".
    await seedExternalGate(runId, "ci", {
      status: "passed",
      verdict: { commitSha: "old" },
    });

    const token = await issueToken({ projectId, name: "ok" }, db);

    const res = await POST(
      makeRequest(
        runId,
        "ci",
        { status: "passed", commitSha: "new" },
        token.secret,
      ),
      ctx(runId, "ci"),
    );

    expect(res.status).toBe(200);

    // Pinned staleOnNewCommit:false → in-place flip, NO supersede. If the
    // resolver had read the mutated flows.manifest (true) it would re-stale the
    // old row and append a fresh one (2 rows).
    const rows = await externalGateRows(runId);

    expect(rows).toHaveLength(1);
    expect(rows.filter((r) => r.status === "stale")).toHaveLength(0);
    expect(rows[0].status).toBe("passed");
    expect((rows[0].verdict as any)?.commitSha).toBe("new");
  });
});
