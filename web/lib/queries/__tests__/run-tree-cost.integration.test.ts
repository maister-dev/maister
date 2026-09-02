import { randomUUID } from "node:crypto";

import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import * as fullSchema from "@/lib/db/schema";
import { testPlatformRunnerRow } from "@/lib/__tests__/runner-fixtures";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const schema = fullSchema as unknown as Record<string, any>;

let testDatabase: StartedPostgresTestDb;
let pool: Pool;
let db: NodePgDatabase;
let projectId: string;
let runnerId: string;

vi.mock("@/lib/db/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db/client")>();

  return { ...actual, getDb: () => db };
});

let getRunTreeCostSummary: typeof import("@/lib/queries/run").getRunTreeCostSummary;

// ADR-165 AC-35 / spec C-16.2. Tree-wide cost facts exist ONLY for a tree ROOT
// that has children — a "tree total" equal to the run total is not a fact.

async function seedRun(args: {
  rootRunId?: string | null;
  parentRunId?: string | null;
  startedAt?: Date;
  endedAt?: Date | null;
}): Promise<string> {
  const runId = randomUUID();

  await pool.query(
    `INSERT INTO "runs" ("id", "run_kind", "project_id", "status", "flow_version", "flow_revision",
       "parent_run_id", "root_run_id", "started_at", "ended_at")
     VALUES ($1, 'flow', $2, 'Done', 'v1', 'rev', $3, $4, $5, $6)`,
    [
      runId,
      projectId,
      args.parentRunId ?? null,
      args.rootRunId ?? null,
      args.startedAt ?? new Date("2026-01-01T00:00:00Z"),
      args.endedAt === undefined
        ? new Date("2026-01-01T00:10:00Z")
        : args.endedAt,
    ],
  );

  return runId;
}

async function seedRollup(
  runId: string,
  tokens: number,
  model = "claude-sonnet-4-6",
): Promise<void> {
  await pool.query(
    `INSERT INTO "run_cost_rollups"
       ("run_id", "project_id", "input_tokens", "output_tokens", "cache_read_tokens",
        "cache_creation_tokens", "by_model")
     VALUES ($1, $2, $3, 0, 0, 0, $4::jsonb)`,
    [runId, projectId, tokens, JSON.stringify({ [model]: { input: tokens } })],
  );
}

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "run_tree_cost_test",
  });
  pool = testDatabase.pool;
  db = testDatabase.db;
  ({ getRunTreeCostSummary } = await import("@/lib/queries/run"));
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

beforeEach(async () => {
  await pool.query(`DELETE FROM "run_cost_rollups"`);
  await pool.query(`DELETE FROM "runs"`);
  await pool.query(`DELETE FROM "projects"`);

  projectId = randomUUID();
  runnerId = randomUUID();
  await pool.query(
    `INSERT INTO "projects" ("id", "slug", "name", "repo_path", "main_branch", "branch_prefix", "maister_yaml_path", "task_key", "next_task_number")
     VALUES ($1, $2, 'P', $3, 'main', 'maister/', '/tmp/maister.yaml', $4, 1)`,
    [
      projectId,
      `p-${projectId.slice(0, 8)}`,
      `/repos/${projectId}`,
      `K${projectId
        .replace(/[^0-9A-Za-z]/g, "")
        .slice(0, 7)
        .toUpperCase()}`,
    ],
  );
  await (db as any)
    .insert(schema.platformAcpRunners)
    .values(testPlatformRunnerRow(runnerId, "claude"));
});

describe("getRunTreeCostSummary (AC-35)", () => {
  it("sums the root and every descendant, by kind and by model", async () => {
    const rootId = randomUUID();

    await pool.query(
      `INSERT INTO "runs" ("id", "run_kind", "project_id", "status", "flow_version", "flow_revision", "root_run_id", "started_at", "ended_at")
       VALUES ($1, 'flow', $2, 'Done', 'v1', 'rev', $1, $3, $4)`,
      [
        rootId,
        projectId,
        new Date("2026-01-01T00:00:00Z"),
        new Date("2026-01-01T00:30:00Z"),
      ],
    );

    const childA = await seedRun({ rootRunId: rootId, parentRunId: rootId });
    const childB = await seedRun({ rootRunId: rootId, parentRunId: rootId });
    // A GRANDCHILD counts too: the scope is `root_run_id`, not `parent_run_id`.
    const grandchild = await seedRun({
      rootRunId: rootId,
      parentRunId: childA,
    });

    await seedRollup(rootId, 100);
    await seedRollup(childA, 200);
    await seedRollup(childB, 300, "claude-opus-5");
    await seedRollup(grandchild, 400);

    const tree = await getRunTreeCostSummary(rootId);

    expect(tree).toMatchObject({
      totalTokens: 1000,
      inputTokens: 1000,
      runCount: 4,
    });
    // by-model merges key by key across the whole tree.
    expect(tree?.byModel).toEqual({
      "claude-sonnet-4-6": { input: 700 },
      "claude-opus-5": { input: 300 },
    });
    expect(tree?.wallClockMinutes).toBeGreaterThan(0);
  }, 60_000);

  it("returns null for a NON-root run", async () => {
    const rootId = randomUUID();

    await pool.query(
      `INSERT INTO "runs" ("id", "run_kind", "project_id", "status", "flow_version", "flow_revision", "root_run_id")
       VALUES ($1, 'flow', $2, 'Done', 'v1', 'rev', $1)`,
      [rootId, projectId],
    );

    const child = await seedRun({ rootRunId: rootId, parentRunId: rootId });

    expect(await getRunTreeCostSummary(child)).toBeNull();
  }, 60_000);

  it("returns null for a CHILDLESS root — a tree total equal to the run total is noise", async () => {
    const rootId = randomUUID();

    await pool.query(
      `INSERT INTO "runs" ("id", "run_kind", "project_id", "status", "flow_version", "flow_revision", "root_run_id")
       VALUES ($1, 'flow', $2, 'Done', 'v1', 'rev', $1)`,
      [rootId, projectId],
    );
    await seedRollup(rootId, 100);

    expect(await getRunTreeCostSummary(rootId)).toBeNull();
  }, 60_000);

  it("returns null for a plain top-level run with no root_run_id at all", async () => {
    const runId = await seedRun({ rootRunId: null });

    expect(await getRunTreeCostSummary(runId)).toBeNull();
  }, 60_000);
});
