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

import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { appendNodeAttempt, markNodeSucceeded } from "@/lib/flows/graph/ledger";
import { createGateResult } from "@/lib/flows/graph/gate-store";
import { assertEvidenceReady } from "@/lib/flows/graph/evidence-readiness";
import { seedGraphRun } from "@/test-support/graph-run-seed";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

let testDatabase: StartedPostgresTestDb;
let db: NodePgDatabase;

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "maister_test",
  });

  db = testDatabase.db;
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

async function seedRun(): Promise<string> {
  const { runId } = await seedGraphRun(
    db,
    { schemaVersion: 1, name: "g", nodes: [] },
    { runnerOnRun: true, workspace: false, run: { status: "Review" } },
  );

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
