// T2.2 — batched per-task token totals for the cross-project work table.
//
// `queryTaskTokens(taskId)` takes ONE id, so calling it per row is the N+1 the
// work table is forbidden to have. The batched sibling must agree with it
// EXACTLY for every seeded task, or two surfaces will report different spend
// for the same task and there will be no way to tell which is lying.

import { randomUUID } from "node:crypto";

import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

let testDatabase: StartedPostgresTestDb;
let pool: Pool;
let db: NodePgDatabase;

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

import { queryTaskTokens, queryTokensByTaskIds } from "@/lib/runs/cost-rollups";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const fx = {
  project: randomUUID(),
  flow: randomUUID(),
  // Two runs, so the per-task total is a real sum and not a single row.
  taskTwoRuns: randomUUID(),
  taskOneRun: randomUUID(),
  // Seeded, but with no cost rollup at all — must read 0, not go missing.
  taskNoRollup: randomUUID(),
};

async function seedRun(taskId: string, tokens: number): Promise<void> {
  const runId = randomUUID();

  await pool.query(
    `insert into runs (id, project_id, task_id, run_kind, status, flow_version, flow_revision)
     values ($1, $2, $3, 'flow', 'Done', 'v1', 'manual')`,
    [runId, fx.project, taskId],
  );
  await pool.query(
    `insert into run_cost_rollups
       (run_id, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens)
     values ($1, $2, 0, 0, 0)`,
    [runId, tokens],
  );
}

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "cost_batched_test",
  });
  pool = testDatabase.pool;
  db = testDatabase.db;

  await pool.query(
    `insert into projects (id, slug, name, repo_path, maister_yaml_path, task_key)
     values ($1, 'cost-batch', 'cost-batch', '/tmp/cost-batch', '/tmp/m.yaml', 'CBT')`,
    [fx.project],
  );
  await pool.query(
    `insert into flows (id, project_id, flow_ref_id, source, version, installed_path, manifest, schema_version)
     values ($1, $2, 'bugfix', 'github.com/x/y', 'v1', '/tmp/f', '{"schemaVersion":1,"name":"B","steps":[]}', 1)`,
    [fx.flow, fx.project],
  );
  let n = 0;

  for (const taskId of [fx.taskTwoRuns, fx.taskOneRun, fx.taskNoRollup]) {
    n += 1;
    await pool.query(
      `insert into tasks (id, project_id, number, title, prompt, flow_id)
       values ($1, $2, $3, $4, 'p', $5)`,
      [taskId, fx.project, n, `Task ${n}`, fx.flow],
    );
  }

  await seedRun(fx.taskTwoRuns, 1200);
  await seedRun(fx.taskTwoRuns, 800);
  await seedRun(fx.taskOneRun, 4321);
});

afterAll(async () => {
  await testDatabase?.stop();
});

describe("queryTokensByTaskIds agrees with queryTaskTokens", () => {
  it("returns, for every seeded task, exactly what the per-task query returns", async () => {
    const ids = [fx.taskTwoRuns, fx.taskOneRun, fx.taskNoRollup];
    const batched = await queryTokensByTaskIds(ids);

    const perTask = new Map<string, number>();

    for (const id of ids) perTask.set(id, await queryTaskTokens(id));

    for (const id of ids) {
      expect(batched.get(id) ?? 0).toBe(perTask.get(id));
    }
  });

  it("sums several runs of one task rather than returning one row", async () => {
    const batched = await queryTokensByTaskIds([fx.taskTwoRuns]);

    expect(batched.get(fx.taskTwoRuns)).toBe(2000);
  });

  it("reports 0 for a task with no cost rollup, never a missing entry", async () => {
    const batched = await queryTokensByTaskIds([fx.taskNoRollup]);

    expect(batched.get(fx.taskNoRollup) ?? 0).toBe(0);
  });

  it("ignores an id that does not exist rather than throwing", async () => {
    const ghost = randomUUID();
    const batched = await queryTokensByTaskIds([fx.taskOneRun, ghost]);

    expect(batched.get(fx.taskOneRun)).toBe(4321);
    expect(batched.get(ghost) ?? 0).toBe(0);
  });
});

describe("queryTokensByTaskIds short-circuits an empty request", () => {
  it("issues NO query for an empty id list", async () => {
    // A client whose `select` throws proves the short-circuit rather than
    // merely observing an empty result, which an executed query also produces.
    const exploding = {
      select() {
        throw new Error(
          "queryTokensByTaskIds issued a query for an empty list",
        );
      },
    };

    await expect(
      queryTokensByTaskIds([], {
        client: exploding as unknown as Parameters<
          typeof queryTokensByTaskIds
        >[1] extends { client?: infer C }
          ? C
          : never,
      }),
    ).resolves.toEqual(new Map());
  });
});
