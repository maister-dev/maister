import type { Pool } from "pg";

import { readMigrationFiles, type MigrationConfig } from "drizzle-orm/migrator";
import { NodePgSession } from "drizzle-orm/node-postgres";
import { PgDialect } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import pino from "pino";

const logger = pino({ name: "test-database-migrations" });

export type TestDatabaseMigrationReceipt = {
  migrationCount: number;
  querySubmissions: number;
  durationMs: number;
};

/** Preserve Drizzle's ledger/transaction semantics with one pending-lineage submission. */
export async function migrateTestDatabase(
  pool: Pool,
  config: MigrationConfig,
): Promise<TestDatabaseMigrationReceipt> {
  const startedAt = Date.now();
  const migrations = readMigrationFiles(config);
  const dialect = new PgDialect();
  const ledger = sql`${sql.identifier(config.migrationsSchema ?? "drizzle")}.${sql.identifier(config.migrationsTable ?? "__drizzle_migrations")}`;
  let querySubmissions = 0;
  const session = new NodePgSession<
    Record<string, never>,
    Record<string, never>
  >(pool, dialect, undefined, {
    logger: {
      logQuery(): void {
        querySubmissions += 1;
      },
    },
  });

  try {
    // Match the installed PgDialect: ledger creation precedes the transaction,
    // and every pending file compares with the same initial high-water mark.
    await session.execute(
      sql`CREATE SCHEMA IF NOT EXISTS ${sql.identifier(config.migrationsSchema ?? "drizzle")}`,
    );
    await session.execute(sql`CREATE TABLE IF NOT EXISTS ${ledger} (
      id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint
    )`);
    const latest = await session.all<{ created_at: string }>(
      sql`SELECT id, hash, created_at FROM ${ledger} ORDER BY created_at DESC LIMIT 1`,
    );
    const pending = migrations.filter(
      (migration) =>
        latest.length === 0 ||
        Number(latest[0].created_at) < migration.folderMillis,
    );

    await session.transaction(async (transaction) => {
      if (pending.length === 0) return;
      const batch = sql.join(
        pending.flatMap((migration) => [
          // PostgreSQL simple-query batches cannot bind values. Drizzle's own
          // string escaping preserves the source-derived hash as a SQL literal.
          // A newline before the terminator also closes trailing SQL comments.
          sql.raw(`${migration.sql.join("\n")}\n;`),
          sql`INSERT INTO ${ledger} ("hash", "created_at") VALUES (
          ${sql.raw(dialect.escapeString(migration.hash))},
          ${sql.raw(String(migration.folderMillis))}
        );`,
        ]),
        sql.raw("\n"),
      );

      await transaction.execute(batch);
    });
  } catch (error) {
    logger.error(
      {
        migrationsFolder: config.migrationsFolder,
        migrationsTable: config.migrationsTable ?? "__drizzle_migrations",
        migrationCount: migrations.length,
        querySubmissions,
        durationMs: Date.now() - startedAt,
      },
      "test database migration failed",
    );
    throw error;
  }

  const receipt: TestDatabaseMigrationReceipt = {
    migrationCount: migrations.length,
    querySubmissions,
    durationMs: Date.now() - startedAt,
  };

  logger.info(
    {
      migrationsFolder: config.migrationsFolder,
      migrationsTable: config.migrationsTable ?? "__drizzle_migrations",
      ...receipt,
    },
    "applied test database migration lineage",
  );

  return receipt;
}
