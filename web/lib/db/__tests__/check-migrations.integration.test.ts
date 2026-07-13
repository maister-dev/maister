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
});
