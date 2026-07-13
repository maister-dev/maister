import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

type Db = NodePgDatabase;

type ColumnRow = {
  table_name: string;
  column_name: string;
  is_nullable: "YES" | "NO";
  column_default: string | null;
  data_type: string;
};

let testDatabase: StartedPostgresTestDb;
let db: Db;

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "maister_migration_0090_test",
  });

  db = testDatabase.db;
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

function id(): string {
  return randomUUID();
}

async function seedBase(): Promise<{
  projectId: string;
  taskId: string;
  runIds: string[];
  userId: string;
}> {
  const projectId = id();
  const taskId = id();
  const userId = id();
  const runIds = [id(), id(), id()];

  await db.execute(sql`
    INSERT INTO users (id, email, role, account_status)
    VALUES (${userId}, ${`u-${userId.slice(0, 8)}@example.test`}, 'member', 'active')
  `);

  await db.execute(sql`
    INSERT INTO projects (id, slug, name, repo_path, task_key)
    VALUES (
      ${projectId},
      ${`proj-${projectId.slice(0, 8)}`},
      'Experiment project',
      ${`/tmp/proj-${projectId.slice(0, 8)}`},
      ${`T${projectId.slice(0, 8)}`.toUpperCase()}
    )
  `);

  await db.execute(sql`
    INSERT INTO tasks (id, project_id, number, title, prompt, created_by_user_id)
    VALUES (${taskId}, ${projectId}, 1, 'Compare variants', 'Build both options', ${userId})
  `);

  for (const runId of runIds) {
    await db.execute(sql`
      INSERT INTO runs (id, task_id, project_id, flow_version)
      VALUES (${runId}, ${taskId}, ${projectId}, 'test')
    `);
  }

  return { projectId, taskId, runIds, userId };
}

async function insertExperiment(args: {
  experimentId: string;
  projectId: string;
  taskId: string;
  userId: string;
  status?: string;
}): Promise<void> {
  await db.execute(sql`
    INSERT INTO experiments (
      id,
      project_id,
      task_id,
      title,
      status,
      base_branch,
      base_commit,
      variants,
      rubric,
      created_by_user_id
    )
    VALUES (
      ${args.experimentId},
      ${args.projectId},
      ${args.taskId},
      'Prompt comparison',
      ${args.status ?? "draft"},
      'main',
      'abcdef1234567890',
      ${JSON.stringify([
        { key: "a", title: "A", prompt: "Try A", config: {} },
        { key: "b", title: "B", prompt: "Try B", config: {} },
      ])}::jsonb,
      ${JSON.stringify({
        criteria: [{ id: "correctness", label: "Correctness", weight: 1 }],
      })}::jsonb,
      ${args.userId}
    )
  `);
}

async function insertExperimentRun(args: {
  id: string;
  experimentId: string;
  runId: string;
  variantKey: string;
  replicateOrdinal: number;
  launchReason?: string;
}): Promise<void> {
  await db.execute(sql`
    INSERT INTO experiment_runs (
      id,
      experiment_id,
      run_id,
      variant_key,
      replicate_ordinal,
      launch_reason,
      base_commit,
      diff_snapshot,
      diff_files_summary,
      materialization_delta
    )
    VALUES (
      ${args.id},
      ${args.experimentId},
      ${args.runId},
      ${args.variantKey},
      ${args.replicateOrdinal},
      ${args.launchReason ?? "initial"},
      'abcdef1234567890',
      'diff --git a/file.ts b/file.ts',
      '[]'::jsonb,
      '{}'::jsonb
    )
  `);
}

async function countRows(table: string): Promise<number> {
  const result = await db.execute<{ count: string }>(
    sql.raw(`SELECT count(*)::text AS count FROM ${table}`),
  );

  return Number(result.rows[0].count);
}

describe("migration 0090 — experiment comparison tables (ADR-124)", () => {
  it("adds the documented tables, columns, defaults, indexes, and checks", async () => {
    const columns = await db.execute<ColumnRow>(sql`
      SELECT table_name, column_name, is_nullable, column_default, data_type
      FROM information_schema.columns
      WHERE table_name IN ('experiments', 'experiment_runs')
      ORDER BY table_name, ordinal_position
    `);

    const byKey = new Map(
      columns.rows.map((row) => [`${row.table_name}.${row.column_name}`, row]),
    );

    expect(byKey.has("experiments.id")).toBe(true);
    expect(byKey.has("experiments.project_id")).toBe(true);
    expect(byKey.has("experiments.task_id")).toBe(true);
    expect(byKey.has("experiments.title")).toBe(true);
    expect(byKey.get("experiments.status")?.column_default).toContain("draft");
    expect(byKey.get("experiments.variants")?.data_type).toBe("jsonb");
    expect(byKey.get("experiments.rubric")?.data_type).toBe("jsonb");
    expect(byKey.get("experiments.verdict")?.data_type).toBe("jsonb");
    expect(byKey.has("experiment_runs.experiment_id")).toBe(true);
    expect(byKey.has("experiment_runs.run_id")).toBe(true);
    expect(byKey.has("experiment_runs.variant_key")).toBe(true);
    expect(byKey.has("experiment_runs.replicate_ordinal")).toBe(true);
    expect(byKey.has("experiment_runs.launch_reason")).toBe(true);
    expect(byKey.get("experiment_runs.diff_snapshot")?.data_type).toBe("text");
    expect(byKey.get("experiment_runs.diff_files_summary")?.data_type).toBe(
      "jsonb",
    );
    expect(byKey.get("experiment_runs.materialization_delta")?.data_type).toBe(
      "jsonb",
    );

    const indexes = await db.execute<{ indexname: string }>(sql`
      SELECT indexname
      FROM pg_indexes
      WHERE tablename IN ('experiments', 'experiment_runs')
    `);
    const indexNames = new Set(indexes.rows.map((row) => row.indexname));

    for (const indexName of [
      "experiments_project_status_idx",
      "experiments_task_idx",
      "experiment_runs_experiment_idx",
      "experiment_runs_run_uq",
      "experiment_runs_variant_replicate_uq",
    ]) {
      expect(indexNames.has(indexName)).toBe(true);
    }

    const checks = await db.execute<{ conname: string }>(sql`
      SELECT conname
      FROM pg_constraint
      WHERE conname IN (
        'experiments_status_check',
        'experiment_runs_launch_reason_check',
        'experiment_runs_replicate_positive_check'
      )
    `);

    expect(new Set(checks.rows.map((row) => row.conname))).toEqual(
      new Set([
        "experiments_status_check",
        "experiment_runs_launch_reason_check",
        "experiment_runs_replicate_positive_check",
      ]),
    );
  });

  it("enforces membership uniqueness, closed sets, and cascade cleanup", async () => {
    const { projectId, taskId, runIds, userId } = await seedBase();
    const experimentId = id();

    await insertExperiment({ experimentId, projectId, taskId, userId });
    await insertExperimentRun({
      id: id(),
      experimentId,
      runId: runIds[0],
      variantKey: "a",
      replicateOrdinal: 1,
    });

    await expect(
      insertExperimentRun({
        id: id(),
        experimentId,
        runId: runIds[0],
        variantKey: "b",
        replicateOrdinal: 1,
      }),
    ).rejects.toThrow(/experiment_runs_run_uq/);

    await expect(
      insertExperimentRun({
        id: id(),
        experimentId,
        runId: runIds[1],
        variantKey: "a",
        replicateOrdinal: 1,
      }),
    ).rejects.toThrow(/experiment_runs_variant_replicate_uq/);

    await expect(
      insertExperimentRun({
        id: id(),
        experimentId,
        runId: runIds[1],
        variantKey: "a",
        replicateOrdinal: 2,
        launchReason: "unknown",
      }),
    ).rejects.toThrow(/experiment_runs_launch_reason_check/);

    await expect(
      insertExperiment({
        experimentId: id(),
        projectId,
        taskId,
        userId,
        status: "paused",
      }),
    ).rejects.toThrow(/experiments_status_check/);

    await db.execute(sql`DELETE FROM experiments WHERE id = ${experimentId}`);

    expect(await countRows("experiment_runs")).toBe(0);
  });
});
