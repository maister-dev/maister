import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { findPendingMigrations } from "@/lib/db/check-migrations";

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;
let prevDbUrl: string | undefined;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("maister_drift_check_test")
    .withUsername("test")
    .withPassword("test")
    .start();

  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);

  // findPendingMigrations gates on a postgres DB_URL (it skips other dialects);
  // point it at the container so the check runs.
  prevDbUrl = process.env.DB_URL;
  process.env.DB_URL = container.getConnectionUri();

  await migrate(db, { migrationsFolder: "./lib/db/migrations" });
}, 180_000);

afterAll(async () => {
  if (prevDbUrl === undefined) delete process.env.DB_URL;
  else process.env.DB_URL = prevDbUrl;

  await pool?.end();
  await container?.stop();
});

describe("findPendingMigrations", () => {
  it("returns [] when the database is fully migrated", async () => {
    expect(await findPendingMigrations(db)).toEqual([]);
  });

  it("flags a journal migration whose ledger row is missing (the silent-skip case)", async () => {
    // Reproduce what an out-of-order `when` does: drizzle never recorded the
    // newest migration. Remove its ledger row and the guard must surface it.
    await db.execute(
      sql`DELETE FROM drizzle.__drizzle_migrations
          WHERE created_at = (SELECT max(created_at) FROM drizzle.__drizzle_migrations)`,
    );

    const pending = await findPendingMigrations(db);

    expect(pending).toContain("0086_yellow_pyro");
  });
});
