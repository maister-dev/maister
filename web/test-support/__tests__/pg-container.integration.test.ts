import { eq, sql } from "drizzle-orm";
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";

import {
  startBarePostgresTestDb,
  startMainAndBrainPostgresTestDb,
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "../pg-container";

const databases: StartedPostgresTestDb[] = [];

afterAll(async () => {
  for (const database of databases.reverse()) {
    await database.stop();
  }
});

describe("shared Testcontainers Postgres helper", () => {
  it("keeps the bare lineage free of migration ledgers", async () => {
    const database = await startBarePostgresTestDb({
      databaseName: "test_support_bare",
    });

    databases.push(database);

    const ledgers = await database.pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'drizzle'`,
    );

    expect(ledgers.rows).toEqual([]);
  });

  it("migrates the main lineage and preserves the requested pool limit", async () => {
    const database = await startMainPostgresTestDb({
      databaseName: "test_support_main",
      poolMax: 3,
    });

    databases.push(database);

    const mainLedger = await database.db.execute(
      sql`SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations`,
    );

    expect(Number(mainLedger.rows[0]?.count)).toBeGreaterThan(0);
    expect(database.pool.options.max).toBe(3);

    const seededAdmin = await database.db.query.users.findFirst({
      where: (users) => eq(users.email, "admin@maister.local"),
    });

    expect(seededAdmin?.email).toBe("admin@maister.local");
  });

  it("migrates Brain after the main lineage", async () => {
    const database = await startMainAndBrainPostgresTestDb({
      databaseName: "test_support_brain",
    });

    databases.push(database);

    const brainLedger = await database.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM drizzle.__drizzle_brain_migrations`,
    );

    expect(Number(brainLedger.rows[0]?.count)).toBeGreaterThan(0);
  });

  it("stops the container when its already-closed pool rejects teardown", async () => {
    const database = await startBarePostgresTestDb({
      databaseName: "test_support_cleanup_failure",
    });

    await database.pool.end();

    try {
      await expect(database.stop()).rejects.toThrow(
        "Called end on pool more than once",
      );

      const freshPool = new Pool({ connectionString: database.databaseUrl });

      try {
        await expect(freshPool.query("SELECT 1")).rejects.toThrow();
      } finally {
        await freshPool.end();
      }
    } finally {
      await database.container.stop();
    }
  });
});
