// RED (M16 Phase 4 §D — CRITICAL atomicity test): the gate-report SUCCESS path
// must execute { gate UPDATE → test_report artifact INSERT → success
// token_audit_log INSERT } in ONE db.transaction. A failure of ANY of the three
// writes MUST roll back the other two — no partial commit.
//
// Spec: docs/system-analytics/external-operations.md §Expectations:
//   "The gate-report success path (gate UPDATE + test_report artifact INSERT +
//    success token_audit_log INSERT) MUST execute in a single db.transaction;
//    any failure MUST roll back all three writes."
//
// HOW THE FAILURE IS FORCED (documented per the QA brief):
//   We module-mock `@/lib/tokens/audit` so that `recordTokenAudit` THROWS when
//   it is called with the success scope `gates:report` + result "ok" (the
//   in-transaction success audit write). The other audit calls (failure-path,
//   handled by handleExt) delegate to the real implementation, so unrelated
//   audit behavior is preserved. Because the throwing call happens INSIDE the
//   route's db.transaction, the gate UPDATE and the test_report INSERT that
//   precede it in the same tx must be rolled back. We assert the gate is still
//   `pending` and NO test_report artifact exists.
//
// The route module does not exist yet → dynamic import fails → RED. Once it
// exists, this verifies real transactional rollback against real Postgres.

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
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { issueToken } from "@/lib/tokens/issue";
import * as schemaModule from "@/lib/db/schema";

const schema = schemaModule as unknown as Record<string, any>;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

// Force the in-transaction SUCCESS audit write to throw; let every other audit
// call fall through to the real implementation. The success path is identified
// by scopeUsed === "gates:report" && result === "ok".
vi.mock("@/lib/tokens/audit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tokens/audit")>();

  return {
    ...actual,
    recordTokenAudit: vi.fn(async (input: any, d?: any) => {
      if (input?.scopeUsed === "gates:report" && input?.result === "ok") {
        throw new Error("forced audit failure (atomicity test)");
      }

      return actual.recordTokenAudit(input, d);
    }),
  };
});

let POST: typeof import("@/app/api/v1/ext/runs/[runId]/gates/[gateId]/report/route").POST;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("ext_gate_report_atomic_test")
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
  const routeModule = await import(
    "@/app/api/v1/ext/runs/[runId]/gates/[gateId]/report/route"
  );

  POST = routeModule.POST;
});

async function seedProjectRunGate() {
  const projectId = randomUUID();
  const flowId = randomUUID();
  const executorId = randomUUID();
  const taskId = randomUUID();
  const runId = randomUUID();
  const nodeAttemptId = randomUUID();
  const gateResultId = randomUUID();
  const slug = `gr-atomic-${randomUUID().slice(0, 8)}`;

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
  await db.insert(schema.executors).values({
    id: executorId,
    projectId,
    executorRefId: "claude-sonnet",
    agent: "claude",
    model: "claude-sonnet-4-6",
  });
  await db.insert(schema.tasks as any).values({
    id: taskId,
    projectId,
    title: "t",
    prompt: "p",
    flowId,
    status: "InFlight",
    stage: "InFlight",
    attemptNumber: 1,
  });
  await db.insert(schema.runs as any).values({
    id: runId,
    taskId,
    projectId,
    flowId,
    executorId,
    status: "Running",
    flowVersion: "v1.0.0",
  });
  await db.insert(schema.workspaces as any).values({
    id: randomUUID(),
    projectId,
    runId,
    branch: "maister/test",
    worktreePath: `/tmp/wt-${runId}`,
    parentRepoPath: `/tmp/repo`,
  });
  await db.insert(schema.nodeAttempts as any).values({
    id: nodeAttemptId,
    runId,
    nodeId: "review",
    nodeType: "check",
    attempt: 1,
    status: "Succeeded",
    startedAt: new Date("2026-06-02T10:00:00.000Z"),
  });
  await db.insert(schema.gateResults as any).values({
    id: gateResultId,
    runId,
    nodeAttemptId,
    gateId: "ci",
    kind: "external_check",
    mode: "blocking",
    status: "pending",
  });

  return { projectId, runId, gateResultId };
}

describe("gate-report atomicity (M16 §D)", () => {
  it("forced in-tx audit failure rolls back the gate flip AND the artifact (no partial commit)", async () => {
    const { projectId, runId, gateResultId } = await seedProjectRunGate();
    const token = await issueToken({ projectId, name: "ok" }, db);

    const req = new NextRequest(
      `http://localhost/api/v1/ext/runs/${runId}/gates/ci/report`,
      {
        method: "POST",
        body: JSON.stringify({ status: "passed", commitSha: "abc" }),
        headers: { "content-type": "application/json" },
      },
    );

    req.headers.set("authorization", `Bearer ${token.secret}`);

    // The route's success transaction throws on the in-tx audit insert. The
    // route may surface this as a thrown error or a 5xx; either way the DB must
    // be unchanged. Tolerate both shapes.
    let threw = false;

    try {
      const res = await POST(req, {
        params: Promise.resolve({ runId, gateId: "ci" }),
      });

      expect(res.status).toBeGreaterThanOrEqual(500);
    } catch {
      threw = true;
    }

    // Whether it threw or 5xx'd, the gate flip and artifact INSERT must roll back.
    void threw;

    const gateRows = (await db
      .select()
      .from(schema.gateResults as any)
      .where(eq(schema.gateResults.id, gateResultId))) as unknown as any[];

    expect(gateRows[0].status).toBe("pending"); // NOT flipped to passed

    const artifacts = (await db
      .select()
      .from(schema.artifactInstances as any)
      .where(eq(schema.artifactInstances.runId, runId))) as unknown as any[];

    const reports = artifacts.filter((a) => a.kind === "test_report");

    expect(reports).toHaveLength(0); // no orphan test_report
  });
});
