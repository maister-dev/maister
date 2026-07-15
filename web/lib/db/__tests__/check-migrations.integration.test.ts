import { readFileSync } from "node:fs";
import { join } from "node:path";

import { sql } from "drizzle-orm";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  findPendingMigrations,
  mainMigrationLedgerHighWater,
} from "@/lib/db/check-migrations";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

let container: StartedPostgresTestDb["container"];
let testDatabase: StartedPostgresTestDb;
let db: NodePgDatabase;
let prevDbUrl: string | undefined;

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "maister_drift_check_test",
  });
  container = testDatabase.container;

  db = testDatabase.db;

  // findPendingMigrations requires a postgres DB_URL; point it at the
  // container so the check runs.
  prevDbUrl = process.env.DB_URL;
  process.env.DB_URL = container.getConnectionUri();
}, 180_000);

afterAll(async () => {
  if (prevDbUrl === undefined) delete process.env.DB_URL;
  else process.env.DB_URL = prevDbUrl;

  await testDatabase?.stop();
});

describe("findPendingMigrations", () => {
  it("returns [] when the database is fully migrated", async () => {
    expect(await findPendingMigrations(db)).toEqual([]);
    expect(await mainMigrationLedgerHighWater(db)).toEqual(expect.any(Number));
  });

  it("flags a journal migration whose ledger row is missing (the silent-skip case)", async () => {
    // Reproduce what an out-of-order `when` does: drizzle never recorded the
    // newest migration. Remove its ledger row and the guard must surface it.
    await db.execute(
      sql`DELETE FROM drizzle.__drizzle_migrations
          WHERE created_at = (SELECT max(created_at) FROM drizzle.__drizzle_migrations)`,
    );

    const pending = await findPendingMigrations(db);

    // Derive the newest journal tag (highest idx) rather than hardcoding it, so
    // adding a migration never silently staleness-breaks this guard test.
    const journal = JSON.parse(
      readFileSync(
        join(process.cwd(), "lib/db/migrations/meta/_journal.json"),
        "utf8",
      ),
    ) as { entries: Array<{ idx: number; tag: string }> };
    const newest = journal.entries.reduce((a, b) => (b.idx > a.idx ? b : a));

    expect(pending).toContain(newest.tag);
  });

  it("applies the project automation storage contract to a fully migrated database", async () => {
    const tables = await db.execute<{ table_name: string }>(sql`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN (
          'scheduled_task_launches',
          'scheduled_task_launch_attempts',
          'scheduled_task_launch_events'
        )
      ORDER BY table_name
    `);
    const constraints = await db.execute<{ conname: string }>(sql`
      SELECT conname
      FROM pg_constraint
      WHERE conname IN (
        'scheduled_task_launches_state_shape_check',
        'runs_scheduled_launch_id_unique'
      )
      ORDER BY conname
    `);
    const indexes = await db.execute<{ indexname: string }>(sql`
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname = 'scheduled_task_launch_attempts_launch_live_uq'
    `);

    expect(tables.rows.map((row) => row.table_name)).toEqual([
      'scheduled_task_launch_attempts',
      'scheduled_task_launch_events',
      'scheduled_task_launches',
    ]);
    expect(constraints.rows.map((row) => row.conname)).toEqual([
      'runs_scheduled_launch_id_unique',
      'scheduled_task_launches_state_shape_check',
    ]);
    expect(indexes.rows.map((row) => row.indexname)).toEqual([
      'scheduled_task_launch_attempts_launch_live_uq',
    ]);
  });
});
