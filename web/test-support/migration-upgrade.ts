import type { StartedPostgresTestDb } from "@/test-support/pg-container";

import { readFile } from "node:fs/promises";

import { readMigrationFiles } from "drizzle-orm/migrator";
import { migrate } from "drizzle-orm/node-postgres/migrator";

/** Seed the production migrator's ledger for a fresh partial-schema fixture, then apply its remaining migrations. */
export async function upgradeMainTestDb(
  database: StartedPostgresTestDb,
  cutoffTag: string,
): Promise<void> {
  const journal = JSON.parse(
    await readFile("./lib/db/migrations/meta/_journal.json", "utf8"),
  ) as {
    entries: Array<{ tag: string; when: number }>;
  };
  const cutoff = journal.entries.find((entry) => entry.tag === cutoffTag)?.when;

  if (!cutoff) throw new Error(`Missing test migration baseline: ${cutoffTag}`);
  const applied = readMigrationFiles({
    migrationsFolder: "./lib/db/migrations",
  }).filter((entry) => entry.folderMillis <= cutoff);

  await database.pool.query(
    "CREATE SCHEMA drizzle; CREATE TABLE drizzle.__drizzle_migrations(id serial PRIMARY KEY,hash text NOT NULL,created_at bigint)",
  );
  await database.pool.query(
    "INSERT INTO drizzle.__drizzle_migrations(hash,created_at) SELECT * FROM unnest($1::text[],$2::bigint[])",
    [
      applied.map((entry) => entry.hash),
      applied.map((entry) => entry.folderMillis),
    ],
  );
  await migrate(database.db, { migrationsFolder: "./lib/db/migrations" });
}
