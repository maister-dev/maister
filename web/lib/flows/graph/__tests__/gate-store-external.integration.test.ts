// RED (M16 Phase 4 §B): reportExternalGate — the gate-store ingestion of an
// external_check report.
//
// Derived from the FROZEN spec:
//   - docs/system-analytics/external-operations.md §"State machine — external_check
//     gate" + §Expectations + §Edge cases.
//   - docs/api/external/operations.openapi.yaml (ExtGateReportBody / verdict fields).
//
// `reportExternalGate({ runId, gateId, status, verdict }, db?)` does NOT exist
// yet (lib/flows/graph/gate-store.ts has no such export) — importing it fails,
// which is a valid RED state. Each assertion is written so that once the symbol
// exists it verifies BEHAVIOR (gate row flip, verdict jsonb contents, test_report
// artifact, supersede-on-new-commit) — not a mock.
//
// Real Postgres via testcontainers, real gate-store, real artifact-store. The
// unit under test (reportExternalGate) is never mocked.

import { randomUUID } from "node:crypto";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as fullSchema from "@/lib/db/schema";
import {
  testPlatformRunnerRow,
  testRunnerSnapshot,
} from "@/lib/__tests__/runner-fixtures";
import { appendNodeAttempt } from "@/lib/flows/graph/ledger";
import { createGateResult } from "@/lib/flows/graph/gate-store";
// RED: this symbol does not exist yet — import will fail until §B lands.
import { reportExternalGate } from "@/lib/flows/graph/gate-store";

const schema = fullSchema as unknown as Record<string, any>;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("maister_test")
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

async function seedRun(): Promise<string> {
  const projectId = randomUUID();
  const executorId = randomUUID();
  const flowId = randomUUID();
  const taskId = randomUUID();
  const runId = randomUUID();

  await db.insert(schema.projects).values({
    id: projectId,
    slug: `proj-${projectId.slice(0, 8)}`,
    name: "Test",
    repoPath: `/tmp/proj-${projectId.slice(0, 8)}`,
    maisterYamlPath: "/tmp/m.yaml",
  });
  await db
    .insert(schema.platformAcpRunners)
    .values(testPlatformRunnerRow(executorId, "claude"));
  await db.insert(schema.flows).values({
    id: flowId,
    projectId,
    flowRefId: "g",
    source: "github.com/x/y",
    version: "v1.0.0",
    installedPath: "/tmp/flows/g",
    manifest: { schemaVersion: 1, name: "g", nodes: [] },
    schemaVersion: 1,
  });
  await db.insert(schema.tasks).values({
    id: taskId,
    projectId,
    title: "t",
    prompt: "p",
    flowId,
  });
  await db.insert(schema.runs).values({
    id: runId,
    taskId,
    projectId,
    flowId,
    runnerId: executorId,
    capabilityAgent: "claude",
    runnerSnapshot: testRunnerSnapshot(executorId, "claude"),
    flowVersion: "v1.0.0",
    status: "Running",
  });

  return runId;
}

/** Seed a pending external_check gate on a fresh node attempt; return ids. */
async function seedPendingExternalGate(
  runId: string,
  gateId = "ci",
): Promise<{ nodeAttemptId: string; gateResultId: string }> {
  const { id: nodeAttemptId } = await appendNodeAttempt({
    runId,
    nodeId: "work",
    nodeType: "check",
    db,
  });

  const { id: gateResultId } = await createGateResult({
    runId,
    nodeAttemptId,
    gateId,
    kind: "external_check",
    mode: "blocking",
    status: "pending",
    db,
  });

  return { nodeAttemptId, gateResultId };
}

async function getGate(gateResultId: string) {
  const rows = (await db
    .select()
    .from(schema.gateResults)
    .where(eq(schema.gateResults.id, gateResultId))) as unknown as any[];

  return rows[0];
}

async function getArtifacts(runId: string) {
  return (await db
    .select()
    .from(schema.artifactInstances)
    .where(eq(schema.artifactInstances.runId, runId))) as unknown as any[];
}

describe("reportExternalGate (M16 §B)", () => {
  it("flips a pending external_check gate to passed and writes verdict metadata", async () => {
    const runId = await seedRun();
    const { gateResultId } = await seedPendingExternalGate(runId);

    await reportExternalGate(
      {
        runId,
        gateId: "ci",
        status: "passed",
        verdict: {
          externalRunUrl: "https://ci.example/run/1",
          commitSha: "abc123",
          reporterTokenId: "tok-1",
          reportedAt: "2026-06-02T10:00:00.000Z",
        },
      },
      db,
    );

    const gate = await getGate(gateResultId);

    expect(gate.status).toBe("passed");
    expect(gate.verdict).toMatchObject({
      externalRunUrl: "https://ci.example/run/1",
      commitSha: "abc123",
      reporterTokenId: "tok-1",
      reportedAt: "2026-06-02T10:00:00.000Z",
    });
  });

  it("flips a pending external_check gate to failed", async () => {
    const runId = await seedRun();
    const { gateResultId } = await seedPendingExternalGate(runId);

    await reportExternalGate(
      {
        runId,
        gateId: "ci",
        status: "failed",
        verdict: { commitSha: "deadbeef", reporterTokenId: "tok-2" },
      },
      db,
    );

    expect((await getGate(gateResultId)).status).toBe("failed");
  });

  it("records a test_report artifact (producer 'gate', inline locator) for the report", async () => {
    const runId = await seedRun();

    await seedPendingExternalGate(runId);

    await reportExternalGate(
      {
        runId,
        gateId: "ci",
        status: "passed",
        verdict: { commitSha: "c1", reporterTokenId: "tok-3" },
      },
      db,
    );

    const artifacts = await getArtifacts(runId);
    const testReport = artifacts.find((a) => a.kind === "test_report");

    expect(testReport).toBeDefined();
    expect(testReport.producer).toBe("gate");
    expect(testReport.locator?.kind).toBe("inline");
  });

  it("flips a stale external_check gate to passed (stale → passed edge)", async () => {
    const runId = await seedRun();
    const { nodeAttemptId } = await seedPendingExternalGate(runId, "ci");
    // Manually drive the gate to `stale` to model the post-rework state.
    const { id: staleGateId } = await createGateResult({
      runId,
      nodeAttemptId,
      gateId: "ci2",
      kind: "external_check",
      mode: "blocking",
      status: "stale",
      db,
    });

    await reportExternalGate(
      {
        runId,
        gateId: "ci2",
        status: "passed",
        verdict: { commitSha: "fresh", reporterTokenId: "tok-4" },
      },
      db,
    );

    expect((await getGate(staleGateId)).status).toBe("passed");
  });

  it("supersede-on-new-commit: a passed report with a DIFFERENT commitSha re-stales the prior passed result", async () => {
    const runId = await seedRun();
    const { gateResultId } = await seedPendingExternalGate(runId);

    // First report passes against commit AAA.
    await reportExternalGate(
      {
        runId,
        gateId: "ci",
        status: "passed",
        verdict: { commitSha: "AAA", reporterTokenId: "tok-5" },
      },
      db,
    );
    expect((await getGate(gateResultId)).status).toBe("passed");

    // A fresh report arrives against a DIFFERENT commit BBB. With
    // external.staleOnNewCommit !== false, the prior passed result is
    // superseded and the gate re-stales (state machine: passed → stale).
    await reportExternalGate(
      {
        runId,
        gateId: "ci",
        status: "passed",
        external: { staleOnNewCommit: true },
        verdict: { commitSha: "BBB", reporterTokenId: "tok-6" },
      },
      db,
    );

    // The PRIOR (first) gate row is superseded/stale — it is no longer a live
    // passed verdict for commit AAA.
    expect((await getGate(gateResultId)).status).toBe("stale");
  });

  it("same-commit re-report flips normally with NO staleness", async () => {
    const runId = await seedRun();
    const { gateResultId } = await seedPendingExternalGate(runId);

    await reportExternalGate(
      {
        runId,
        gateId: "ci",
        status: "passed",
        verdict: { commitSha: "SAME", reporterTokenId: "tok-7" },
      },
      db,
    );

    // Re-report against the SAME commit → flips normally, never stales.
    await reportExternalGate(
      {
        runId,
        gateId: "ci",
        status: "passed",
        external: { staleOnNewCommit: true },
        verdict: { commitSha: "SAME", reporterTokenId: "tok-8" },
      },
      db,
    );

    expect((await getGate(gateResultId)).status).toBe("passed");

    // Same-commit re-report is an in-place flip: exactly ONE external_check row
    // (the original is reused, never a duplicate superseding row).
    const extRows = (
      (await db
        .select()
        .from(schema.gateResults)
        .where(eq(schema.gateResults.runId, runId))) as unknown as any[]
    ).filter((r) => r.kind === "external_check");

    expect(extRows).toHaveLength(1);
    expect(extRows[0].id).toBe(gateResultId);

    // Each accepted report records its own test_report artifact (append, not
    // deduplicated) — two reports → two artifacts.
    expect(
      (await getArtifacts(runId)).filter((a) => a.kind === "test_report"),
    ).toHaveLength(2);
  });

  it("staleOnNewCommit:false opts out of commit-based staleness even on a new commit", async () => {
    const runId = await seedRun();
    const { gateResultId } = await seedPendingExternalGate(runId);

    await reportExternalGate(
      {
        runId,
        gateId: "ci",
        status: "passed",
        external: { staleOnNewCommit: false },
        verdict: { commitSha: "X1", reporterTokenId: "tok-9" },
      },
      db,
    );

    await reportExternalGate(
      {
        runId,
        gateId: "ci",
        status: "passed",
        external: { staleOnNewCommit: false },
        verdict: { commitSha: "X2", reporterTokenId: "tok-10" },
      },
      db,
    );

    // staleOnNewCommit:false → commit change does NOT re-stale the gate.
    expect((await getGate(gateResultId)).status).toBe("passed");
  });
});
