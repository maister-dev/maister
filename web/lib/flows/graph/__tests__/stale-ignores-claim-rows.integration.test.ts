import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { markDownstreamStale } from "@/lib/flows/graph/ledger";
import { schema, seedGraphRun } from "@/test-support/graph-run-seed";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

// T-A13 (AC-A13) / T-A14 (AC-A14) — ADR-160 D10.
//
// A takeover/rework CLAIM row is a human-handoff marker, not a node execution.
// `latestAttemptByNode` picks the highest-attempt row per node, so a claim row
// appended at node X becomes "the latest attempt at X" and SHIELDS X's real
// last execution — and its `passed` gate_results — from `markDownstreamStale`.
//
// For the Feature-A rework claim this is the GENERAL case, not an edge case:
// the claim anchors on the LAST EXECUTED node, which is by construction
// downstream of any re-entry, so its gates are shielded on EVERY claim.
//
// The fix is one predicate applied unconditionally for every caller: pick the
// latest attempt with `owner_user_id IS NULL`. Whether the M11b takeover shape
// was also affected is settled here BY EXPERIMENT (T-A14), not by argument.

let testDatabase: StartedPostgresTestDb;
let db: NodePgDatabase;

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "stale_claim_rows_test",
  });
  db = testDatabase.db;
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

const MANIFEST = {
  schemaVersion: 1,
  name: "Stale Fixture",
  nodes: [
    {
      id: "verify",
      type: "cli",
      action: { command: "true" },
      transitions: { success: "done" },
    },
  ],
};

const NODE = "verify";

type Seeded = {
  runId: string;
  executedAttemptId: string;
  claimAttemptId: string;
  gateId: string;
};

// Seeds the exact shape a claim produces: a real executed attempt carrying a
// `passed` gate, then a claim row appended at the SAME node with a higher
// attempt number and a non-null owner.
async function seedClaimOverExecutedAttempt(opts: {
  // ADR-160 rework claims write this; an ADR-030 takeover leaves it unset.
  decision?: string;
}): Promise<Seeded> {
  const { runId } = await seedGraphRun(db, MANIFEST, {
    flowRefId: "stale-fixture",
    runnerOnRun: true,
    workspace: false,
    run: { status: "Review" },
  });

  const ownerId = randomUUID();

  await db.insert(schema.users).values({
    id: ownerId,
    email: `owner-${ownerId.slice(0, 8)}@maister.local`,
    role: "member",
    accountStatus: "active",
    passwordHash: "x",
  });

  const executedAttemptId = randomUUID();

  await db.insert(schema.nodeAttempts).values({
    id: executedAttemptId,
    runId,
    nodeId: NODE,
    nodeType: "cli",
    attempt: 1,
    status: "Succeeded",
    startedAt: new Date(Date.now() - 60_000),
    endedAt: new Date(Date.now() - 50_000),
  });

  const gateId = randomUUID();

  await db.insert(schema.gateResults).values({
    id: gateId,
    runId,
    nodeAttemptId: executedAttemptId,
    gateId: "checks",
    kind: "command_check",
    blocking: true,
    status: "passed",
  });

  // The claim row: same node, higher attempt, owner set, still open.
  const claimAttemptId = randomUUID();

  await db.insert(schema.nodeAttempts).values({
    id: claimAttemptId,
    runId,
    nodeId: NODE,
    nodeType: "human",
    attempt: 2,
    status: "NeedsInput",
    ownerUserId: ownerId,
    startedAt: new Date(),
    endedAt: null,
    ...(opts.decision !== undefined ? { decision: opts.decision } : {}),
  });

  return { runId, executedAttemptId, claimAttemptId, gateId };
}

async function gateStatus(gateId: string): Promise<string> {
  const rows = await db
    .select({ status: schema.gateResults.status })
    .from(schema.gateResults)
    .where(eq(schema.gateResults.id, gateId));

  return rows[0].status;
}

async function attemptStatus(attemptId: string): Promise<string> {
  const rows = await db
    .select({ status: schema.nodeAttempts.status })
    .from(schema.nodeAttempts)
    .where(eq(schema.nodeAttempts.id, attemptId));

  return rows[0].status;
}

describe("ADR-160 D10 — markDownstreamStale ignores claim rows", () => {
  it("T-A13 — a rework claim row does not shield the node's real last execution", async () => {
    const s = await seedClaimOverExecutedAttempt({
      decision: "review_rework_claim",
    });

    const result = await markDownstreamStale(s.runId, [NODE], db);

    // The executed attempt and ITS passed gate are what must go stale.
    expect(await gateStatus(s.gateId)).toBe("stale");
    expect(await attemptStatus(s.executedAttemptId)).toBe("Stale");
    expect(result.staledGates).toBeGreaterThanOrEqual(1);

    // The claim row itself is a handoff marker, never a node execution — it is
    // not staled and stays open for the return to close.
    expect(await attemptStatus(s.claimAttemptId)).toBe("NeedsInput");
  });

  it("T-A14 — the same holds for the ADR-030 takeover shape (no `decision` marker)", async () => {
    const s = await seedClaimOverExecutedAttempt({});

    const result = await markDownstreamStale(s.runId, [NODE], db);

    expect(await gateStatus(s.gateId)).toBe("stale");
    expect(await attemptStatus(s.executedAttemptId)).toBe("Stale");
    expect(result.staledGates).toBeGreaterThanOrEqual(1);
    expect(await attemptStatus(s.claimAttemptId)).toBe("NeedsInput");
  });

  // Fail-closed direction check: with no claim row in play the behaviour is
  // exactly today's, so the fix can only ever stale MORE, never less.
  it("leaves the no-claim case byte-identical", async () => {
    const { runId } = await seedGraphRun(db, MANIFEST, {
      flowRefId: "stale-fixture",
      runnerOnRun: true,
      workspace: false,
      run: { status: "Review" },
    });
    const attemptId = randomUUID();

    await db.insert(schema.nodeAttempts).values({
      id: attemptId,
      runId,
      nodeId: NODE,
      nodeType: "cli",
      attempt: 1,
      status: "Succeeded",
      startedAt: new Date(),
      endedAt: new Date(),
    });

    const gateId = randomUUID();

    await db.insert(schema.gateResults).values({
      id: gateId,
      runId,
      nodeAttemptId: attemptId,
      gateId: "checks",
      kind: "command_check",
      blocking: true,
      status: "passed",
    });

    await markDownstreamStale(runId, [NODE], db);

    expect(await gateStatus(gateId)).toBe("stale");
    expect(await attemptStatus(attemptId)).toBe("Stale");
  });
});
