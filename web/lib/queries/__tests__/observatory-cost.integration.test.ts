// ADR-117 Phase 3: getCostSummary aggregates the persisted run_cost_rollups
// by_model + by_runner jsonb columns into sorted CostDimensionRow[] breakdowns,
// alongside the existing flat token totals. It is a PURE read over derived
// rollups — it MUST NOT reconcile or read cost.jsonl (Observatory read-only
// boundary, §272 / D4).

import { randomUUID } from "node:crypto";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import * as schema from "@/lib/db/schema";
import { getCostSummary } from "@/lib/queries/observatory";

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase<typeof schema>;
let projectId: string;
let projectSlug: string;

const scope = () => [{ id: projectId, slug: projectSlug, name: "Cost" }];

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("observatory_cost_test")
    .withUsername("test")
    .withPassword("test")
    .start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder: "./lib/db/migrations" });
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

beforeEach(async () => {
  await db.delete(schema.runCostRollups);
  await db.delete(schema.runs);
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

async function seedRollup(opts: {
  runKind?: "flow" | "scratch" | "agent";
  input: number;
  byModel?: Record<string, Record<string, number>>;
  byRunner?: Record<string, Record<string, number>>;
}): Promise<string> {
  const runId = randomUUID();

  await db.insert(schema.runs).values({
    id: runId,
    projectId,
    status: "Done",
    runKind: opts.runKind ?? "flow",
    flowVersion: "v1.0.0",
    startedAt: new Date(),
    endedAt: new Date(),
  });
  await db.insert(schema.runCostRollups).values({
    runId,
    projectId,
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
