import { Pool } from "pg";
import { expect, it, onTestFinished } from "vitest";

import { startMainAndBrainPostgresTestDbTemplate } from "../pg-container";

it("clones the migrated schema without sharing case writes or rebuilding containers", async () => {
  const template = await startMainAndBrainPostgresTestDbTemplate({
    databaseName: "fault_template",
    poolMax: 2,
  });

  onTestFinished(() => template.stop());
  const first = await template.createDatabase();
  let second: typeof first | undefined;

  try {
    const ledgers = await first.pool.query(
      "SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id",
    );
    const brain = await first.pool.query(
      "SELECT hash, created_at FROM drizzle.__drizzle_brain_migrations ORDER BY id",
    );

    expect(ledgers.rows.length).toBeGreaterThan(0);
    expect(brain.rows.length).toBeGreaterThan(0);
    await first.pool.query("CREATE TABLE case_private (id serial PRIMARY KEY)");
    await first.pool.query("INSERT INTO case_private DEFAULT VALUES");
    await first.pool.query(
      "UPDATE users SET email = 'first-case@example.test'",
    );
    second = await template.createDatabase();
    expect(second.container.getId()).toBe(first.container.getId());
    expect(second.databaseUrl).not.toBe(first.databaseUrl);
    expect(second.pool.options.max).toBe(2);
    expect(
      (
        await second.pool.query(
          "SELECT to_regclass('case_private') AS relation",
        )
      ).rows,
    ).toEqual([{ relation: null }]);
    expect(
      (
        await second.pool.query(
          "SELECT email FROM users WHERE email = 'first-case@example.test'",
        )
      ).rows,
    ).toEqual([]);
    expect(
      (
        await second.pool.query(
          "SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id",
        )
      ).rows,
    ).toEqual(ledgers.rows);
    expect(
      (
        await second.pool.query(
          "SELECT hash, created_at FROM drizzle.__drizzle_brain_migrations ORDER BY id",
        )
      ).rows,
    ).toEqual(brain.rows);
  } finally {
    await first.stop();
    if (second) {
      expect((await second.pool.query("SELECT 1 AS alive")).rows).toEqual([
        { alive: 1 },
      ]);
      await second.stop();
    }
  }
});

it("freezes the template and drops a case even when its pool was closed incorrectly", async () => {
  const template = await startMainAndBrainPostgresTestDbTemplate({
    databaseName: "fault_frozen",
  });

  onTestFinished(() => template.stop());
  const database = await template.createDatabase();
  const templateUrl = new URL(database.databaseUrl);

  templateUrl.pathname = "/fault_frozen";
  const frozenPool = new Pool({ connectionString: templateUrl.href });
  const adminUrl = new URL(database.databaseUrl);

  adminUrl.pathname = "/postgres";
  const admin = new Pool({ connectionString: adminUrl.href });

  try {
    await expect(frozenPool.query("SELECT 1")).rejects.toMatchObject({
      code: "55000",
    });
    await database.pool.end();
    await expect(database.stop()).rejects.toMatchObject({
      errors: [
        expect.objectContaining({
          message: "Called end on pool more than once",
        }),
      ],
    });
    expect(
      (
        await admin.query(
          "SELECT datname FROM pg_database WHERE datname = $1",
          [new URL(database.databaseUrl).pathname.slice(1)],
        )
      ).rows,
    ).toEqual([]);
  } finally {
    try {
      await frozenPool.end();
    } finally {
      await admin.end();
    }
  }
});

it("reports an unclosed case while reclaiming its pool and container", async () => {
  const template = await startMainAndBrainPostgresTestDbTemplate({
    databaseName: "fault_leak",
  });
  let databaseUrl = "";

  try {
    const database = await template.createDatabase();

    databaseUrl = database.databaseUrl;
    await database.pool.query("SELECT 1");
  } finally {
    await expect(template.stop()).rejects.toMatchObject({
      errors: [
        expect.objectContaining({
          message: expect.stringContaining("unclosed cases"),
        }),
      ],
    });
  }
  await expect(template.createDatabase()).rejects.toThrow(
    "template is stopping",
  );
  const probe = new Pool({ connectionString: databaseUrl });

  try {
    await expect(probe.query("SELECT 1")).rejects.toThrow();
  } finally {
    await probe.end();
  }
});

it("settles a pending allocation before stopping its template", async () => {
  const template = await startMainAndBrainPostgresTestDbTemplate({
    databaseName: "fault_pending",
  });
  const allocating = template.createDatabase();
  const stopping = template.stop();

  await Promise.all([
    expect(allocating).rejects.toThrow(
      "allocation interrupted by template shutdown",
    ),
    expect(stopping).rejects.toMatchObject({
      errors: [
        expect.objectContaining({
          message: "test database allocation interrupted by template shutdown",
        }),
      ],
    }),
  ]);
});
