// ADR-117 Phase 2: the cost-rollup-reconcile domain-event consumer is a
// low-latency fast-path that reconciles run_cost_rollups seconds after a
// terminal that DOES emit (run.done|failed|crashed|abandoned). It is poison-safe
// — a per-run reconcile error is logged and swallowed so a single permanently
// failing run never stalls the dispatch cursor (the dispatcher breaks without
// advancing on a handle throw).
//
// Harness mirrors dispatch.integration.test.ts + cost-rollups.integration.test.ts.

import type { DomainEventRow } from "@/lib/db/schema";

import { randomUUID } from "node:crypto";

import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import * as schemaModule from "@/lib/db/schema";
import { buildCostRollupReconcileConsumer } from "@/lib/domain-events/cost-rollup-reconcile";
import { dispatchDomainEvents } from "@/lib/domain-events/dispatch";
import { reconcileRunCostRollups } from "@/lib/runs/cost-rollups";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const schema = schemaModule as unknown as Record<string, any>;

const PROJECT_SLUG = "consumer-cost-app";

let testDatabase: StartedPostgresTestDb;
let db: NodePgDatabase;
let projectId: string;

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "cost_consumer_test",
  });

  db = testDatabase.db;

  projectId = randomUUID();
  await db.insert(schema.projects).values({
    id: projectId,
    taskKey: `T${randomUUID().slice(0, 8)}`.toUpperCase(),
    slug: PROJECT_SLUG,
    name: "Consumer Cost App",
    repoPath: "/repos/consumer-cost-app",
    maisterYamlPath: "/repos/consumer-cost-app/maister.yaml",
  });

}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

beforeEach(async () => {
  await db.delete(schema.domainEvents);
  await db.delete(schema.domainEventConsumers);
  await db.delete(schema.runCostRollups);
  await db.delete(schema.runSessions);
  await db.delete(schema.runs);
  await db.delete(schema.localPackages);
  await db.delete(schema.packageInstalls);
});

async function seedRun(opts: {
  runKind?: string;
  projectId?: string | null;
  localPackageId?: string | null;
}): Promise<string> {
  const runId = randomUUID();

  await db.insert(schema.runs).values({
    id: runId,
    projectId: opts.projectId === undefined ? projectId : opts.projectId,
    localPackageId: opts.localPackageId ?? null,
    status: "Done",
    runKind: opts.runKind ?? "scratch",
    flowVersion: "v1.0.0",
    startedAt: new Date(),
    endedAt: new Date(),
  });

  return runId;
}

async function seedSession(runId: string, slug = "claude"): Promise<void> {
  await db.insert(schema.runSessions).values({
    id: randomUUID(),
    runId,
    sessionName: "default",
    runnerSnapshot: {
      id: randomUUID(),
      adapter: slug,
      capabilityAgent: slug,
      model: "claude-sonnet-4-6",
      providerKind: "anthropic",
      permissionPolicy: "auto",
    },
  });
}

async function recordCanonicalUsage(runId: string, input: number): Promise<void> {
  await db.insert(schema.executionEvents).values({
    id: randomUUID(),
    source: "manager",
    sourceKey: `cost-consumer:${runId}:0`,
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

function evt(kind: string, runId: string | null, id = 1): DomainEventRow {
  return {
    id,
    kind,
    projectId,
    taskId: null,
    runId,
    actorType: null,
    actorId: null,
    payload: {},
    occurredAt: new Date(),
    createdAt: new Date(),
    txId: "0",
  } as unknown as DomainEventRow;
}

async function rollupRow(
  runId: string,
): Promise<{ inputTokens: number; sourceCursor: string | null } | undefined> {
  const [row] = await db
    .select({
      inputTokens: schema.runCostRollups.inputTokens,
      sourceCursor: schema.runCostRollups.sourceCursor,
    })
    .from(schema.runCostRollups)
    .where(eq(schema.runCostRollups.runId, runId));

  return row;
}

describe("cost-rollup-reconcile consumer", () => {
  it("reconciles a never-opened scratch run on its run.failed terminal", async () => {
    const runId = await seedRun({ runKind: "scratch" });

    await seedSession(runId);
    await recordCanonicalUsage(runId, 42);

    const consumer = buildCostRollupReconcileConsumer({ db });

    await consumer.handle([evt("run.failed", runId)]);

    const row = await rollupRow(runId);

    expect(row?.inputTokens).toBe(42);
  });

  it("reconciles only terminal kinds, dedupes runIds, ignores non-terminal events", async () => {
    const runA = await seedRun({});
    const runB = await seedRun({});
    const runC = await seedRun({});

    for (const r of [runA, runB, runC]) {
      await seedSession(r);
      await recordCanonicalUsage(r, 5);
    }

    const calls: string[] = [];
    const consumer = buildCostRollupReconcileConsumer({
      db,
      reconcile: (
        runId: string,
        opts: Parameters<typeof reconcileRunCostRollups>[1],
      ) => {
        calls.push(runId);

        return reconcileRunCostRollups(runId, opts);
      },
    });

    await consumer.handle([
      evt("run.failed", runA, 1),
      evt("run.crashed", runA, 2), // same run → deduped
      evt("run.done", runB, 3),
      evt("run.escalated", runC, 4), // non-terminal → ignored
    ]);

    expect(calls.sort()).toEqual([runA, runB].sort());
    expect(await rollupRow(runC)).toBeUndefined();
  });

  it("is idempotent across at-least-once redelivery (one rollup, stable cursor)", async () => {
    const runId = await seedRun({});

    await seedSession(runId);
    await recordCanonicalUsage(runId, 9);

    const consumer = buildCostRollupReconcileConsumer({ db });

    await consumer.handle([evt("run.done", runId)]);
    const first = await rollupRow(runId);

    await consumer.handle([evt("run.done", runId)]);
    const second = await rollupRow(runId);

    expect(second?.inputTokens).toBe(9);
    expect(second?.sourceCursor).toBe(first?.sourceCursor);

    const all = await db
      .select({ runId: schema.runCostRollups.runId })
      .from(schema.runCostRollups);

    expect(all).toHaveLength(1);
  });

  it("writes no row and does not throw when no usage event exists", async () => {
    const runId = await seedRun({});

    await seedSession(runId);
    // No canonical usage event exists.

    const consumer = buildCostRollupReconcileConsumer({ db });

    await expect(
      consumer.handle([evt("run.failed", runId)]),
    ).resolves.toBeUndefined();
    expect(await rollupRow(runId)).toBeUndefined();
  });

  it("is poison-safe: an always-failing run never stalls the dispatch cursor", async () => {
    // A malformed reconciliation must not stop a healthy run alongside it; the
    // cursor must advance so a later healthy event is delivered.
    const poisonRun = await seedRun({ projectId: null, localPackageId: null });
    const healthy1 = await seedRun({});

    await seedSession(healthy1);
    await recordCanonicalUsage(healthy1, 11);

    const consumer = buildCostRollupReconcileConsumer({ db });

    // Prime the "now" cursor at 0 against the empty table so the events below
    // are delivered (a startFrom:"now" consumer otherwise seeds past any backlog
    // inserted before its first dispatch).
    await dispatchDomainEvents({ db, consumers: [consumer] });

    await db.insert(schema.domainEvents).values([
      {
        kind: "run.failed",
        projectId,
        runId: poisonRun,
        payload: {},
        occurredAt: new Date(),
      },
      {
        kind: "run.done",
        projectId,
        runId: healthy1,
        payload: {},
        occurredAt: new Date(),
      },
    ]);

    const summary = await dispatchDomainEvents({ db, consumers: [consumer] });

    expect(summary.failures).toBe(0); // handle resolved despite the poison run
    expect((await rollupRow(healthy1))?.inputTokens).toBe(11);

    // The cursor advanced past the poison batch → a later healthy event flows.
    const healthy2 = await seedRun({});

    await seedSession(healthy2);
    await recordCanonicalUsage(healthy2, 22);
    await db.insert(schema.domainEvents).values({
      kind: "run.crashed",
      projectId,
      runId: healthy2,
      payload: {},
      occurredAt: new Date(),
    });

    await dispatchDomainEvents({ db, consumers: [consumer] });

    expect((await rollupRow(healthy2))?.inputTokens).toBe(22);
  });

  it("reconciles a project-less local-package run without deriving a filesystem slug", async () => {
    const lpId = randomUUID();
    const lpSlug = "lp-cost";

    await db.insert(schema.localPackages).values({
      id: lpId,
      name: "Local Cost Pkg",
      slug: lpSlug,
      workingDir: "/tmp/lp-cost",
    });
    const runId = await seedRun({
      runKind: "scratch",
      projectId: null,
      localPackageId: lpId,
    });

    await seedSession(runId);
    await recordCanonicalUsage(runId, 7);

    const consumer = buildCostRollupReconcileConsumer({ db });

    await consumer.handle([evt("run.failed", runId)]);

    expect((await rollupRow(runId))?.inputTokens).toBe(7);
  });
});
