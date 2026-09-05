// ADR-117 Phase 2: reconcileTerminalCostRollups is the system_sweep backstop —
// the completeness guarantee for run_cost_rollups. It keys on runs.ended_at (NOT
// a status allow-list, NOT a domain event), so it catches scratch-success runs
// that emit no terminal event, plus historical backfill and late usage-event
// arrival. SETTLE_GRACE forces one extra re-reconcile of a just-ended run so a
// late durable usage event is captured; a long-settled rollup is skipped.

import { randomUUID } from "node:crypto";

import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import * as schemaModule from "@/lib/db/schema";
import { reconcileTerminalCostRollups } from "@/lib/runs/cost-reconcile-sweep";
import { reconcileRunCostRollups } from "@/lib/runs/cost-rollups";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const schema = schemaModule as unknown as Record<string, any>;

const PROJECT_SLUG = "sweep-cost-app";

let testDatabase: StartedPostgresTestDb;
let db: NodePgDatabase;
let projectId: string;

const dbAny = (): NodePgDatabase<any> => db as NodePgDatabase<any>;

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "cost_sweep_test",
  });

  db = testDatabase.db;

  projectId = randomUUID();
  await db.insert(schema.projects).values({
    id: projectId,
    taskKey: `T${randomUUID().slice(0, 8)}`.toUpperCase(),
    slug: PROJECT_SLUG,
    name: "Sweep Cost App",
    repoPath: "/repos/sweep-cost-app",
    maisterYamlPath: "/repos/sweep-cost-app/maister.yaml",
  });
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

beforeEach(async () => {
  await db.delete(schema.runCostRollups);
  await db.delete(schema.runSessions);
  await db.delete(schema.runs);
});

async function seedRun(opts: {
  endedAt: Date | null;
  runKind?: string;
  costReconciledAt?: Date | null;
}): Promise<string> {
  const runId = randomUUID();

  await db.insert(schema.runs).values({
    id: runId,
    projectId,
    status: opts.endedAt ? "Done" : "Running",
    runKind: opts.runKind ?? "scratch",
    flowVersion: "v1.0.0",
    startedAt: new Date(),
    endedAt: opts.endedAt,
    costReconciledAt: opts.costReconciledAt ?? null,
  });

  return runId;
}

async function costReconciledAtOf(runId: string): Promise<Date | null> {
  const [row] = await db
    .select({ costReconciledAt: schema.runs.costReconciledAt })
    .from(schema.runs)
    .where(eq(schema.runs.id, runId));

  return row?.costReconciledAt ?? null;
}

async function byRunnerOf(
  runId: string,
): Promise<Record<string, Record<string, number>>> {
  const [row] = await db
    .select({ byRunner: schema.runCostRollups.byRunner })
    .from(schema.runCostRollups)
    .where(eq(schema.runCostRollups.runId, runId));

  return (row?.byRunner ?? {}) as Record<string, Record<string, number>>;
}

async function seedSession(runId: string): Promise<void> {
  await db.insert(schema.runSessions).values({
    id: randomUUID(),
    runId,
    sessionName: "default",
    runnerSnapshot: {
      id: randomUUID(),
      adapter: "claude",
      capabilityAgent: "claude",
      model: "claude-sonnet-4-6",
      providerKind: "anthropic",
      permissionPolicy: "auto",
    },
  });
}

async function seedRollup(
  runId: string,
  input: number,
  updatedAt: Date,
): Promise<void> {
  await db.insert(schema.runCostRollups).values({
    runId,
    projectId,
    inputTokens: input,
    sourceEventCount: 1,
    updatedAt,
  });
}

async function recordCanonicalUsage(
  runId: string,
  input: number,
): Promise<void> {
  await db.insert(schema.executionEvents).values({
    id: randomUUID(),
    source: "manager",
    sourceKey: `cost-sweep:${runId}:0`,
    runId,
    eventType: "usage.recorded",
    payloadSchema: "maister.usage.recorded.v1",
    payload: {
      sessionName: "default",
      model: "claude-sonnet-4-6",
      inputTokens: input,
    },
    occurredAt: new Date(),
    receivedAt: new Date(),
    runSequence: BigInt(0),
    ingestDisposition: "accepted",
  });
}

async function inputTokensOf(runId: string): Promise<number | undefined> {
  const [row] = await db
    .select({ inputTokens: schema.runCostRollups.inputTokens })
    .from(schema.runCostRollups)
    .where(eq(schema.runCostRollups.runId, runId));

  return row?.inputTokens;
}

describe("reconcileTerminalCostRollups — backstop sweep", () => {
  it("reconciles a finished scratch run that fired no event and was never opened", async () => {
    const now = new Date();
    const runId = await seedRun({
      endedAt: new Date(now.getTime() - 60_000),
      runKind: "scratch",
    });

    await seedSession(runId);
    await recordCanonicalUsage(runId, 77);

    const summary = await reconcileTerminalCostRollups({
      client: dbAny(),
      now,
    });

    expect(summary.reconciled).toBe(1);
    expect(await inputTokensOf(runId)).toBe(77);
  });

  it("re-reconciles an ended run whose marker is still within ended_at + SETTLE_GRACE (late flush)", async () => {
    const now = new Date();
    const endedAt = new Date(now.getTime() - 30_000);
    // Reconciled once at ended_at (before the supervisor's final flush): the
    // marker is within grace, so the run stays a candidate for one more pass.
    const runId = await seedRun({ endedAt, costReconciledAt: endedAt });

    await seedSession(runId);
    // The canonical event history now has MORE than the stale rollup captured.
    await recordCanonicalUsage(runId, 200);
    await seedRollup(runId, 5, endedAt);

    await reconcileTerminalCostRollups({
      client: dbAny(),
      now,
      settleGraceMs: 120_000,
    });

    expect(await inputTokensOf(runId)).toBe(200);
    // The marker advanced to the attempt time (past grace → now settled).
    expect((await costReconciledAtOf(runId))?.getTime()).toBe(now.getTime());
  });

  it("skips an ended run whose marker is long-settled (no redundant disk read)", async () => {
    const now = new Date();
    const endedAt = new Date(now.getTime() - 10 * 60_000);
    // Marker stamped well after ended_at + grace → settled, must be skipped.
    const runId = await seedRun({
      endedAt,
      costReconciledAt: new Date(endedAt.getTime() + 5 * 60_000),
    });

    await seedSession(runId);

    const calls: string[] = [];
    const summary = await reconcileTerminalCostRollups({
      client: dbAny(),
      now,
      settleGraceMs: 120_000,
      reconcile: (
        runId: string,
        opts: Parameters<typeof reconcileRunCostRollups>[1],
      ) => {
        calls.push(runId);

        return reconcileRunCostRollups(runId, opts);
      },
    });

    expect(calls).toEqual([]);
    expect(summary.reconciled).toBe(0);
  });

  it("bounds candidates by the limit, oldest ended_at first", async () => {
    const now = new Date();
    const oldest = await seedRun({ endedAt: new Date(now.getTime() - 3000) });
    const middle = await seedRun({ endedAt: new Date(now.getTime() - 2000) });
    const newest = await seedRun({ endedAt: new Date(now.getTime() - 1000) });

    const calls: string[] = [];

    await reconcileTerminalCostRollups({
      client: dbAny(),
      now,
      limit: 2,
      reconcile: (runId: string) => {
        calls.push(runId);

        return Promise.resolve({
          status: "reconciled" as const,
          sourceEventCount: 0,
        });
      },
    });

    expect(calls.sort()).toEqual([oldest, middle].sort());
    expect(calls).not.toContain(newest);
  });

  it("never reconciles a still-active run (ended_at IS NULL)", async () => {
    const now = new Date();

    await seedRun({ endedAt: null });

    const calls: string[] = [];
    const summary = await reconcileTerminalCostRollups({
      client: dbAny(),
      now,
      reconcile: (runId: string) => {
        calls.push(runId);

        return Promise.resolve({
          status: "reconciled" as const,
          sourceEventCount: 0,
        });
      },
    });

    expect(calls).toEqual([]);
    expect(summary.candidates).toBe(0);
  });

  it("backfills by_runner for a pre-0083 rollup (empty by_runner, never swept) within lookback", async () => {
    const now = new Date();
    const endedAt = new Date(now.getTime() - 3 * 60 * 60_000);
    // Pre-0083 state: the rollup was created by a run-detail open long AFTER the
    // run ended (updated_at >> ended_at + grace, so the old updated_at predicate
    // would have treated it as settled), it has an empty by_runner, and the
    // sweep has never attempted it (NULL marker).
    const runId = await seedRun({ endedAt, costReconciledAt: null });

    await seedSession(runId);
    await recordCanonicalUsage(runId, 50);
    await seedRollup(runId, 50, new Date(endedAt.getTime() + 60 * 60_000));

    await reconcileTerminalCostRollups({ client: dbAny(), now });

    // The NULL marker makes it a candidate → reconcile recomputes by_runner.
    expect(Object.keys(await byRunnerOf(runId))).toEqual([
      "claude/claude-sonnet-4-6",
    ]);
    expect(await costReconciledAtOf(runId)).not.toBeNull();
  });

  it("does not let old runs without usage events starve a newer healthy run", async () => {
    const now = new Date();
    // Two old runs have no usage events. Under the old
    // rollup-state predicate these stayed candidates every tick and, oldest-first
    // under the per-tick cap, blocked the newer run forever.
    const old1 = await seedRun({
      endedAt: new Date(now.getTime() - 3 * 60 * 60_000),
    });
    const old2 = await seedRun({
      endedAt: new Date(now.getTime() - 2 * 60 * 60_000),
    });
    // A newer healthy scratch run has usage events.
    const healthy = await seedRun({
      endedAt: new Date(now.getTime() - 60_000),
    });

    await seedSession(healthy);
    await recordCanonicalUsage(healthy, 88);

    // Tick 1: oldest-first + limit 2 selects the two old zero-usage runs; the
    // healthy run is beyond the cap. Each old run is stamped → settled.
    await reconcileTerminalCostRollups({
      client: dbAny(),
      now,
      limit: 2,
    });

    expect(await inputTokensOf(healthy)).toBeUndefined();
    expect(await costReconciledAtOf(old1)).not.toBeNull();
    expect(await costReconciledAtOf(old2)).not.toBeNull();

    // Tick 2: the two old runs are settled (marker past grace), so the healthy
    // run is now selected and reconciled — no permanent starvation.
    await reconcileTerminalCostRollups({
      client: dbAny(),
      now: new Date(now.getTime() + 60_000),
      limit: 2,
    });

    expect(await inputTokensOf(healthy)).toBe(88);
  });
});
