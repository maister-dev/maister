// RED (M16 Phase 4 §C): assertEvidenceReady extended for external_check gates.
//
// Derived from the FROZEN spec:
//   - docs/system-analytics/external-operations.md §Expectations:
//     "A blocking external_check gate in pending, failed, stale, or skipped
//      status MUST cause assertEvidenceReady(runId, 'review') to return blocked;
//      the review node MUST NOT complete unless the gate is overridden."
//   - Allow-list semantics: ready ONLY when passed/overridden (NOT a deny-list).
//
// assertEvidenceReady EXISTS today but only queries `artifact_required` gates
// (lib/flows/graph/evidence-readiness.ts line ~120 filters kind="artifact_required").
// It does NOT yet query kind="external_check" — so a blocking pending/failed/stale
// external_check is wrongly treated as ready. These assertions are RED until §C.
//
// The existing artifact_required logic must stay intact; one test re-asserts an
// artifact_required path still blocks, to catch a regression in the extension.

import { randomUUID } from "node:crypto";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as fullSchema from "@/lib/db/schema";
import {
  testPlatformRunnerRow,
  testRunnerSnapshot,
} from "@/lib/__tests__/runner-fixtures";
import { appendNodeAttempt, markNodeSucceeded } from "@/lib/flows/graph/ledger";
import { createGateResult } from "@/lib/flows/graph/gate-store";
import { assertEvidenceReady } from "@/lib/flows/graph/evidence-readiness";

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
    status: "Review",
  });

  return runId;
}

// Seed an external_check gate at the given status on the latest attempt of a
// node so assertEvidenceReady's latest-attempt filter keeps it live.
async function seedExternalGate(
  runId: string,
  gateId: string,
  status: string,
  mode: "blocking" | "advisory" = "blocking",
): Promise<void> {
  const { id: nodeAttemptId } = await appendNodeAttempt({
    runId,
    nodeId: `node-${gateId}`,
    nodeType: "check",
    db,
  });

  await markNodeSucceeded(nodeAttemptId, { stdout: "" }, db);

  await createGateResult({
    runId,
    nodeAttemptId,
    gateId,
    kind: "external_check",
    mode,
    status: status as any,
    db,
  });
}

describe("assertEvidenceReady — external_check awareness (M16 §C)", () => {
  it("blocking external_check 'pending' → ready=false, reason names the gate id", async () => {
    const runId = await seedRun();

    await seedExternalGate(runId, "ci-pending", "pending");

    const result = await assertEvidenceReady(runId, "review", db);

    expect(result.ready).toBe(false);
    expect(result.reasons.join(" ")).toContain("ci-pending");
  });

  it("blocking external_check 'failed' → ready=false", async () => {
    const runId = await seedRun();

    await seedExternalGate(runId, "ci-failed", "failed");

    const result = await assertEvidenceReady(runId, "review", db);

    expect(result.ready).toBe(false);
    expect(result.reasons.join(" ")).toContain("ci-failed");
  });

  it("blocking external_check 'stale' → ready=false", async () => {
    const runId = await seedRun();

    await seedExternalGate(runId, "ci-stale", "stale");

    const result = await assertEvidenceReady(runId, "review", db);

    expect(result.ready).toBe(false);
    expect(result.reasons.join(" ")).toContain("ci-stale");
  });

  it("blocking external_check 'skipped' → ready=false", async () => {
    const runId = await seedRun();

    await seedExternalGate(runId, "ci-skipped", "skipped");

    const result = await assertEvidenceReady(runId, "review", db);

    expect(result.ready).toBe(false);
    expect(result.reasons.join(" ")).toContain("ci-skipped");
  });

  it("blocking external_check 'passed' → does NOT block (allow-list)", async () => {
    const runId = await seedRun();

    await seedExternalGate(runId, "ci-passed", "passed");

    const result = await assertEvidenceReady(runId, "review", db);

    expect(result.ready).toBe(true);
    expect(result.reasons).toHaveLength(0);
  });

  it("blocking external_check 'overridden' → does NOT block", async () => {
    const runId = await seedRun();

    await seedExternalGate(runId, "ci-overridden", "overridden");

    const result = await assertEvidenceReady(runId, "review", db);

    expect(result.ready).toBe(true);
    expect(result.reasons).toHaveLength(0);
  });

  it("advisory external_check 'failed' → does NOT block (only blocking gates gate review)", async () => {
    const runId = await seedRun();

    await seedExternalGate(runId, "ci-advisory", "failed", "advisory");

    const result = await assertEvidenceReady(runId, "review", db);

    expect(result.ready).toBe(true);
  });

  it("regression: existing blocking artifact_required 'stale' still blocks review", async () => {
    const runId = await seedRun();

    const { id: nodeAttemptId } = await appendNodeAttempt({
      runId,
      nodeId: "art-node",
      nodeType: "check",
      db,
    });

    await markNodeSucceeded(nodeAttemptId, { stdout: "" }, db);
    await createGateResult({
      runId,
      nodeAttemptId,
      gateId: "verify-artifacts",
      kind: "artifact_required",
      mode: "blocking",
      status: "stale",
      db,
    });

    const result = await assertEvidenceReady(runId, "review", db);

    expect(result.ready).toBe(false);
    expect(result.reasons.join(" ")).toContain("verify-artifacts");
  });
});
