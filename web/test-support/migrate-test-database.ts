import type { Pool } from "pg";

import { readMigrationFiles, type MigrationConfig } from "drizzle-orm/migrator";
import { NodePgSession } from "drizzle-orm/node-postgres";
import { PgDialect } from "drizzle-orm/pg-core";
import pino from "pino";

const logger = pino({ name: "test-database-migrations" });

export type TestDatabaseMigrationReceipt = {
  migrationCount: number;
  querySubmissions: number;
  durationMs: number;
};

/** Apply the committed lineage using Drizzle's transaction and ledger contract. */
export async function migrateTestDatabase(
  pool: Pool,
  config: MigrationConfig,
): Promise<TestDatabaseMigrationReceipt> {
  const startedAt = Date.now();
  const migrations = readMigrationFiles(config).map((migration) => ({
    ...migration,
    // Keep SQL bytes and statement terminators; only remove Drizzle's transport splits.
    sql: [migration.sql.join("\n")],
  }));
  const dialect = new PgDialect();
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
    await dialect.migrate(migrations, session, config);
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
