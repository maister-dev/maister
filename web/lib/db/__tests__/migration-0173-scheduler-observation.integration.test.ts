import { rm } from "node:fs/promises";
import { resolve } from "node:path";

import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createMigrationRootThrough } from "@/lib/db/m43-cutover-migration-root";
import {
  startBarePostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const MIGRATIONS_FOLDER = resolve(process.cwd(), "lib/db/migrations");
const PREVIOUS_MIGRATION = "0172_mcp_env_values";
const CURRENT_ATTEMPT_ID = "zz-current-attempt";
const PREVIOUS_ATTEMPT_ID = "yy-previous-attempt";
const HISTORY_SIZE = 50_000;

describe("migration 0173_scheduler_observation_lookup", () => {
  let database: StartedPostgresTestDb;
  let previousMigrationRoot: string;

  beforeAll(async () => {
    database = await startBarePostgresTestDb({
      databaseName: "migration_0173_scheduler_observation",
    });
    previousMigrationRoot = await createMigrationRootThrough(
      MIGRATIONS_FOLDER,
      PREVIOUS_MIGRATION,
    );
    await migrate(database.db, { migrationsFolder: previousMigrationRoot });

    await database.pool.query(`
      INSERT INTO scheduler_jobs (
        id, job_kind, cadence_interval_seconds, next_run_at
      ) VALUES (
        'system-sweep', 'system_sweep', 60, NOW()
      )
    `);
    await database.pool.query(
      `INSERT INTO scheduler_job_runs (
         id, job_id, job_kind, status, claimed_at, lease_expires_at, summary
       )
       SELECT
         'history-' || LPAD(sequence::text, 6, '0'),
         'system-sweep',
         'system_sweep',
         CASE WHEN sequence % 2 = 0 THEN 'Succeeded' ELSE 'Failed' END,
         TIMESTAMPTZ '2026-09-20 00:00:00Z' + sequence * INTERVAL '1 millisecond',
         TIMESTAMPTZ '2026-09-20 00:01:00Z' + sequence * INTERVAL '1 millisecond',
         jsonb_build_object('sequence', sequence)
       FROM generate_series(1, $1) AS sequence`,
      [HISTORY_SIZE],
    );
    await database.pool.query(
      `INSERT INTO scheduler_job_runs (
         id, job_id, job_kind, status, claimed_at, lease_expires_at, summary
       ) VALUES
         ($1, 'system-sweep', 'system_sweep', 'Failed',
          TIMESTAMPTZ '2026-09-21 12:00:00Z',
          TIMESTAMPTZ '2026-09-21 12:01:00Z', '{"outcome":"previous"}'::jsonb),
         ($2, 'system-sweep', 'system_sweep', 'Running',
          TIMESTAMPTZ '2026-09-21 12:00:00Z',
          TIMESTAMPTZ '2026-09-21 12:01:00Z', '{"outcome":"current"}'::jsonb)`,
      [PREVIOUS_ATTEMPT_ID, CURRENT_ATTEMPT_ID],
    );
  }, 300_000);

  afterAll(async () => {
    await database?.stop();
    if (previousMigrationRoot) {
      await rm(previousMigrationRoot, { recursive: true, force: true });
    }
  });

  it("adds a deterministic ordered lookup and preserves scheduler history", async () => {
    const beforeIndex = await database.pool.query(
      `SELECT indexdef
       FROM pg_indexes
       WHERE schemaname = 'public'
         AND indexname = 'scheduler_job_runs_job_claimed_idx'`,
    );
    const beforeCount = await database.pool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM scheduler_job_runs",
    );

    expect(beforeIndex.rows).toHaveLength(0);
    expect(beforeCount.rows[0]?.count).toBe(String(HISTORY_SIZE + 2));

    await migrate(database.db, { migrationsFolder: MIGRATIONS_FOLDER });

    const afterIndex = await database.pool.query<{ indexdef: string }>(
      `SELECT indexdef
       FROM pg_indexes
       WHERE schemaname = 'public'
         AND indexname = 'scheduler_job_runs_job_claimed_idx'`,
    );
    const previous = await database.pool.query<{
      id: string;
      status: string;
      summary: Record<string, unknown>;
    }>(
      `SELECT id, status, summary
       FROM scheduler_job_runs
       WHERE job_id = 'system-sweep' AND id <> $1
       ORDER BY claimed_at DESC, id DESC
       LIMIT 1`,
      [CURRENT_ATTEMPT_ID],
    );
    const afterCount = await database.pool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM scheduler_job_runs",
    );

    expect(afterIndex.rows[0]?.indexdef).toContain("(job_id, claimed_at, id)");
    expect(previous.rows).toEqual([
      {
        id: PREVIOUS_ATTEMPT_ID,
        status: "Failed",
        summary: { outcome: "previous" },
      },
    ]);
    expect(afterCount.rows[0]?.count).toBe(beforeCount.rows[0]?.count);
  });

  it("uses the composite index and re-runs the normal migrator as a no-op", async () => {
    await database.pool.query("ANALYZE scheduler_job_runs");

    const explained = await database.pool.query<{ "QUERY PLAN": string }>(
      `EXPLAIN (ANALYZE, BUFFERS)
       SELECT id, summary
       FROM scheduler_job_runs
       WHERE job_id = 'system-sweep' AND id <> $1
       ORDER BY claimed_at DESC, id DESC
       LIMIT 1`,
      [CURRENT_ATTEMPT_ID],
    );
    const plan = explained.rows.map((row) => row["QUERY PLAN"]).join("\n");

    expect(plan).toMatch(
      /Index (?:Only )?Scan(?: Backward)? using scheduler_job_runs_job_claimed_idx/,
    );

    await migrate(database.db, { migrationsFolder: MIGRATIONS_FOLDER });

    const rows = await database.pool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM scheduler_job_runs",
    );

    expect(rows.rows[0]?.count).toBe(String(HISTORY_SIZE + 2));
  });
});
