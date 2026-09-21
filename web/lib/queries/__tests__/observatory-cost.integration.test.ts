// ADR-117 Phase 3: getCostSummary aggregates the persisted run_cost_rollups
// by_model + by_runner jsonb columns into sorted CostDimensionRow[] breakdowns,
// alongside the existing flat token totals. It is a PURE read over derived
// rollups — it MUST NOT reconcile or read cost.jsonl (Observatory read-only
// boundary, §272 / D4).

import { randomUUID } from "node:crypto";

import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import * as schema from "@/lib/db/schema";
import { getCostSummary } from "@/lib/queries/observatory";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

let testDatabase: StartedPostgresTestDb;
let db: NodePgDatabase<typeof schema>;
let projectId: string;
let projectSlug: string;

const scope = () => [{ id: projectId, slug: projectSlug, name: "Cost" }];

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "observatory_cost_test",
  });
  db = testDatabase.db;
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

beforeEach(async () => {
  await db.delete(schema.runCostRollups);
  await db.delete(schema.runs);
  await db.delete(schema.flows);
  await db.delete(schema.projects);

  projectId = randomUUID();
  projectSlug = `cost-${projectId.slice(0, 8)}`;
  await db.insert(schema.projects).values({
    id: projectId,
    taskKey: `T${randomUUID().slice(0, 8)}`.toUpperCase(),
    slug: projectSlug,
    name: "Cost",
    repoPath: `/repos/${projectSlug}`,
    maisterYamlPath: `/repos/${projectSlug}/maister.yaml`,
  });
});

function bucket(input: number) {
  return {
    inputTokens: input,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  };
}

async function seedFlow(flowRefId: string): Promise<string> {
  const id = randomUUID();

  await db.insert(schema.flows).values({
    id,
    projectId,
    flowRefId,
    source: `https://example.invalid/${flowRefId}`,
    version: "v1.0.0",
    installedPath: `/flows/${flowRefId}`,
    manifest: { schemaVersion: 1, name: flowRefId, nodes: [] },
    schemaVersion: 1,
  });

  return id;
}

async function seedRollup(opts: {
  runKind?: "flow" | "scratch" | "agent";
  input: number;
  byModel?: Record<string, Record<string, number>>;
  byRunner?: Record<string, Record<string, number>>;
  flowId?: string;
  startedAt?: Date;
}): Promise<string> {
  const runId = randomUUID();
  const startedAt = opts.startedAt ?? new Date();

  await db.insert(schema.runs).values({
    id: runId,
    projectId,
    status: "Done",
    runKind: opts.runKind ?? "flow",
    flowId: opts.flowId ?? null,
    flowVersion: "v1.0.0",
    startedAt,
    endedAt: startedAt,
  });
  await db.insert(schema.runCostRollups).values({
    runId,
    projectId,
    flowId: opts.flowId ?? null,
    inputTokens: opts.input,
    sourceEventCount: 1,
    byModel: opts.byModel ?? {},
    byRunner: opts.byRunner ?? {},
  });

  return runId;
}

describe("getCostSummary — model + runner breakdown", () => {
  it("sums by_model and by_runner across runs (incl. scratch), sorted by totalTokens desc", async () => {
    await seedRollup({
      runKind: "flow",
      input: 110,
      byModel: { "model-a": bucket(100), "model-b": bucket(10) },
      byRunner: { "claude/sonnet": bucket(100), "codex/gpt5": bucket(10) },
    });
    await seedRollup({
      runKind: "scratch",
      input: 50,
      byModel: { "model-a": bucket(50) },
      byRunner: { "claude/sonnet": bucket(50) },
    });

    const cost = await getCostSummary(db, scope(), {});

    // Scratch tokens are included in the flat totals.
    expect(cost.inputTokens).toBe(160);
    expect(cost.byKind.map((row) => [row.kind, row.totalTokens])).toEqual([
      ["flow", 110],
      ["scratch", 50],
      ["agent", 0],
    ]);

    expect(cost.byModel).toEqual([
      {
        key: "model-a",
        label: "model-a",
        inputTokens: 150,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        totalTokens: 150,
      },
      {
        key: "model-b",
        label: "model-b",
        inputTokens: 10,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        totalTokens: 10,
      },
    ]);

    expect(cost.byRunner.map((r) => [r.key, r.totalTokens] as const)).toEqual([
      ["claude/sonnet", 150],
      ["codex/gpt5", 10],
    ]);
  });

  it("filters cost and its node companion by the selected run kind", async () => {
    await seedRollup({ runKind: "flow", input: 10 });
    await seedRollup({ runKind: "scratch", input: 20 });

    const cost = await getCostSummary(db, scope(), { runKind: "scratch" });

    expect(cost.inputTokens).toBe(20);
    expect(cost.byKind).toEqual([
      expect.objectContaining({ kind: "scratch", totalTokens: 20 }),
    ]);
  });

  it("returns empty breakdowns for a project with no cost rows", async () => {
    const cost = await getCostSummary(db, scope(), {});

    expect(cost.byModel).toEqual([]);
    expect(cost.byRunner).toEqual([]);
  });

  it("surfaces an 'unknown' runner row for unattributed cost", async () => {
    await seedRollup({
      input: 7,
      byModel: { "model-a": bucket(7) },
      byRunner: { unknown: bucket(7) },
    });

    const cost = await getCostSummary(db, scope(), {});

    expect(cost.byRunner).toEqual([
      {
        key: "unknown",
        label: "unknown",
        inputTokens: 7,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        totalTokens: 7,
      },
    ]);
  });

  it("excludes a rollup whose run started before the window (ADR-177 D5)", async () => {
    const outside = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000);

    await seedRollup({
      input: 999,
      startedAt: outside,
      byModel: { "model-old": bucket(999) },
      byRunner: { "claude/old": bucket(999) },
    });
    await seedRollup({
      input: 7,
      byModel: { "model-a": bucket(7) },
      byRunner: { "claude/sonnet": bucket(7) },
    });

    const cost = await getCostSummary(db, scope(), {});

    expect(cost.inputTokens).toBe(7);
    expect(cost.byModel.map((row) => row.key)).toEqual(["model-a"]);
    expect(cost.byRunner.map((row) => row.key)).toEqual(["claude/sonnet"]);
    expect(cost.byKind.map((row) => [row.kind, row.totalTokens])).toEqual([
      ["flow", 7],
      ["scratch", 0],
      ["agent", 0],
    ]);

    // An explicit window that DOES reach the old run sees both again.
    const wide = await getCostSummary(db, scope(), {
      since: new Date(outside.getTime() - 1000),
      until: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });

    expect(wide.inputTokens).toBe(1006);
  });

  it("breaks cost down by flow ref, with scratch and agent pseudo-rows", async () => {
    const bugfix = await seedFlow("bugfix");
    const specKit = await seedFlow("spec-kit");

    await seedRollup({ input: 100, flowId: bugfix });
    await seedRollup({ input: 25, flowId: bugfix });
    await seedRollup({ input: 60, flowId: specKit });
    await seedRollup({ runKind: "scratch", input: 40 });
    await seedRollup({ runKind: "agent", input: 40 });

    const cost = await getCostSummary(db, scope(), {});

    expect(cost.byFlow.map((row) => [row.key, row.totalTokens])).toEqual([
      ["bugfix", 125],
      ["spec-kit", 60],
      // Equal totals fall back to the key, so `agent` precedes `scratch`.
      ["agent", 40],
      ["scratch", 40],
    ]);
  });

  it("buckets a flow run whose flow row is gone under 'unknown'", async () => {
    await seedRollup({ input: 11 });

    const cost = await getCostSummary(db, scope(), {});

    expect(cost.byFlow.map((row) => [row.key, row.totalTokens])).toEqual([
      ["unknown", 11],
    ]);
  });

  it("returns an empty byFlow for a project with no cost rows", async () => {
    expect((await getCostSummary(db, scope(), {})).byFlow).toEqual([]);
  });

  it("is read-only: it never writes or mutates rollup rows (D4 / §272)", async () => {
    const runId = await seedRollup({
      input: 5,
      byRunner: { "claude/sonnet": bucket(5) },
    });
    const [before] = await db
      .select({ updatedAt: schema.runCostRollups.updatedAt })
      .from(schema.runCostRollups)
      .where(eq(schema.runCostRollups.runId, runId));

    await getCostSummary(db, scope(), {});

    const rows = await db
      .select({ updatedAt: schema.runCostRollups.updatedAt })
      .from(schema.runCostRollups);

    // No row created, none mutated.
    expect(rows).toHaveLength(1);
    expect(rows[0].updatedAt.getTime()).toBe(before.updatedAt.getTime());
  });
});
