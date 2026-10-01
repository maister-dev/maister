import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { seedProjectRow, seedRun } from "@/test-support/execution-host-seed";
import {
  applyMainMigration,
  startMainPostgresTestDb,
  startMainPostgresTestDbUpTo,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

let database: StartedPostgresTestDb;
const userId = randomUUID();
const legacyRuns = [randomUUID(), randomUUID(), randomUUID()];

beforeAll(async () => {
  database = await startMainPostgresTestDbUpTo(
    { databaseName: "migration_0192_scratch_intent" },
    "0191_librarian_start_lease",
  );
  const project = await seedProjectRow(database.db);

  await database.db.execute(sql`
    INSERT INTO users (id, email) VALUES (${userId}, ${`intent-${userId}@example.test`})
  `);
  for (const [index, status] of [
    "WaitingForUser",
    "Running",
    "NeedsInput",
  ].entries()) {
    const runId = legacyRuns[index];

    await seedRun(database.db, {
      id: runId,
      projectId: project.id,
      runKind: "scratch",
      status: status === "NeedsInput" ? "NeedsInput" : "Running",
    });
    await database.db.execute(sql`
      INSERT INTO scratch_runs
        (run_id, project_id, initial_prompt, base_branch, base_commit,
         dialog_status, created_by_user_id)
      VALUES (${runId}, ${project.id}, 'Legacy prompt', 'main', 'legacy-commit',
              ${status}, ${userId})
    `);
  }

  await applyMainMigration(database.db, "0192_scratch_prompt_intent");
}, 180_000);

afterAll(async () => {
  await database?.stop();
});

describe("S1 migration 0192: scratch prompt intent", () => {
  it("preserves queued, Running, and parked legacy rows without fabricating an intent", async () => {
    const rows = await database.db.execute(sql`
      SELECT run_id, dialog_status, active_prompt_intent
      FROM scratch_runs WHERE run_id IN (${sql.join(
        legacyRuns.map((id) => sql`${id}`),
        sql`, `,
      )})
      ORDER BY dialog_status
    `);

    expect(rows.rows).toHaveLength(3);
    expect(rows.rows.map((row) => row.active_prompt_intent)).toEqual([
      null,
      null,
      null,
    ]);
  });

  it("stores a bounded versioned object and rejects unsupported shapes", async () => {
    await database.db.execute(sql`
      UPDATE scratch_runs
      SET active_prompt_intent = '{"version":1,"owner":"message"}'::jsonb
      WHERE run_id = ${legacyRuns[1]}
    `);
    const stored = await database.db.execute(sql`
      SELECT active_prompt_intent FROM scratch_runs WHERE run_id = ${legacyRuns[1]}
    `);

    expect(stored.rows[0]?.active_prompt_intent).toEqual({
      version: 1,
      owner: "message",
    });

    await expect(
      database.db.execute(sql`
        UPDATE scratch_runs SET active_prompt_intent = '[]'::jsonb
        WHERE run_id = ${legacyRuns[1]}
      `),
    ).rejects.toMatchObject({
      constraint: "scratch_runs_prompt_intent_shape_check",
    });
    await expect(
      database.db.execute(sql`
        UPDATE scratch_runs SET active_prompt_intent = '{"version":2}'::jsonb
        WHERE run_id = ${legacyRuns[1]}
      `),
    ).rejects.toMatchObject({
      constraint: "scratch_runs_prompt_intent_shape_check",
    });
    await expect(
      database.db.execute(sql`
        UPDATE scratch_runs SET active_prompt_intent = '{"version":"1"}'::jsonb
        WHERE run_id = ${legacyRuns[1]}
      `),
    ).rejects.toMatchObject({
      constraint: "scratch_runs_prompt_intent_shape_check",
    });
    await expect(
      database.db.execute(sql`
        UPDATE scratch_runs SET active_prompt_intent = '{}'::jsonb
        WHERE run_id = ${legacyRuns[1]}
      `),
    ).rejects.toMatchObject({
      constraint: "scratch_runs_prompt_intent_shape_check",
    });
    await expect(
      database.db.execute(sql`
        UPDATE scratch_runs
        SET active_prompt_intent = jsonb_build_object(
          'version', 1, 'prompt', repeat('x', 4194304)
        )
        WHERE run_id = ${legacyRuns[1]}
      `),
    ).rejects.toMatchObject({
      constraint: "scratch_runs_prompt_intent_shape_check",
    });
  });

  it("indexes only Running dialogs by age and run id", async () => {
    const indexes = await database.db.execute(sql`
      SELECT indexdef FROM pg_indexes
      WHERE tablename = 'scratch_runs'
        AND indexname = 'scratch_runs_running_intent_sweep_idx'
    `);

    expect(indexes.rows).toHaveLength(1);
    expect(indexes.rows[0]?.indexdef).toMatch(/updated_at.*run_id/);
    expect(indexes.rows[0]?.indexdef).toContain("dialog_status = 'Running'");
  });

  it("applies in the complete main migration lineage", async () => {
    const fresh = await startMainPostgresTestDb({
      databaseName: "migration_0192_empty",
    });

    try {
      const column = await fresh.db.execute(sql`
        SELECT data_type FROM information_schema.columns
        WHERE table_name = 'scratch_runs' AND column_name = 'active_prompt_intent'
      `);

      expect(column.rows).toEqual([{ data_type: "jsonb" }]);
    } finally {
      await fresh.stop();
    }
  });
});
