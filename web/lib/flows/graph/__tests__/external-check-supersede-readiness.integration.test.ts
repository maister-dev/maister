// RED regression (M16 Phase 4 — supersede dedup): after a supersede-on-new-commit
// report, reportExternalGate leaves the PRIOR passed row `stale` and creates a
// FRESH passed row on the SAME nodeAttemptId (its documented behavior). The two
// readiness readers must collapse external_check rows to the LATEST report per
// gateId on the live attempt and evaluate only that representative — otherwise the
// leftover `stale` row leaks and:
//   - assertEvidenceReady(runId, "review") wrongly returns ready=false, and
//   - getRunReadiness().readiness wrongly resolves to "stale" with the gate
//     listed twice in externalGates[].
//
// Intended semantics (confirmed): the LATEST report per gateId governs. A
// new-commit passing report ⇒ gate effectively passed ⇒ review proceeds.
//
// This test seeds a blocking external_check gate, reports passed@AAA (sanity:
// ready), then reports passed@BBB (supersede). It asserts both readers treat the
// gate as passed. RED until both readers dedup-to-latest-per-gateId.

import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { appendNodeAttempt, markNodeSucceeded } from "@/lib/flows/graph/ledger";
import {
  createGateResult,
  reportExternalGate,
} from "@/lib/flows/graph/gate-store";
import { assertEvidenceReady } from "@/lib/flows/graph/evidence-readiness";
import { getRunReadiness } from "@/lib/queries/readiness";
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

async function seedRun(): Promise<{ runId: string; projectId: string }> {
  const { runId, projectId } = await seedGraphRun(
    db,
    { schemaVersion: 1, name: "g", nodes: [] },
    { runnerOnRun: true, workspace: false, run: { status: "Review" } },
  );

  return { runId, projectId };
}

async function seedPendingBlockingExternalGate(runId: string): Promise<void> {
  const { id: nodeAttemptId } = await appendNodeAttempt({
    runId,
    nodeId: "work",
    nodeType: "check",
    db,
  });

  await markNodeSucceeded(nodeAttemptId, { stdout: "" }, db);
  await createGateResult({
    runId,
    nodeAttemptId,
    gateId: "ci",
    kind: "external_check",
    mode: "blocking",
    status: "pending",
    db,
  });
}

describe("external_check supersede — readers dedup to latest-per-gateId", () => {
  it("a new-commit passing report keeps review ready and lists the gate once", async () => {
    const { runId, projectId } = await seedRun();

    await seedPendingBlockingExternalGate(runId);

    // First report passes against commit AAA.
    await reportExternalGate(
      {
        runId,
        gateId: "ci",
        status: "passed",
        verdict: { commitSha: "AAA", reporterTokenId: "tok-aaa" },
      },
      db,
    );

    // Sanity: a single passed external gate ⇒ review ready.
    const sanity = await assertEvidenceReady(runId, "review", db);

    expect(sanity.ready).toBe(true);

    // Fresh report against a DIFFERENT commit BBB ⇒ supersede: the prior passed
    // row goes `stale` and a fresh `passed` row is created on the same attempt.
    await reportExternalGate(
      {
        runId,
        gateId: "ci",
        status: "passed",
        external: { staleOnNewCommit: true },
        verdict: { commitSha: "BBB", reporterTokenId: "tok-bbb" },
      },
      db,
    );

    // (a) evidence-readiness must read the gate as passed (latest report wins),
    // NOT see the leftover stale row and refuse.
    const after = await assertEvidenceReady(runId, "review", db);

    expect(after.ready).toBe(true);
    expect(after.reasons).toHaveLength(0);

    // (b) readiness DTO: ready, with EXACTLY ONE entry for "ci" at status passed.
    const dto = await getRunReadiness(runId, projectId, db);

    expect(dto).not.toBeNull();

    const ciEntries = dto!.externalGates.filter((g) => g.gateId === "ci");

    expect(ciEntries).toHaveLength(1);
    expect(ciEntries[0].status).toBe("passed");
    expect(dto!.readiness).toBe("ready");
  });
});
