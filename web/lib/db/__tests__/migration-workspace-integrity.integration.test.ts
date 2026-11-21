import { sql } from "drizzle-orm";
import { expect, it } from "vitest";

import {
  applyMainMigration,
  startMainPostgresTestDbUpTo,
} from "@/test-support/pg-container";

it("WI-01 upgrades populated settings without materializing inherited limits", async () => {
  const database = await startMainPostgresTestDbUpTo(
    { databaseName: "workspace_integrity_upgrade" },
    "0359_acp_context_projection_state",
  );

  try {
    await database.pool.query(`
      INSERT INTO platform_acp_runners (id, adapter, capability_agent, model, provider)
      VALUES ('legacy', 'codex', 'codex', 'legacy', '{}');
      INSERT INTO platform_runtime_settings (id, default_runner_id)
      VALUES ('singleton', 'legacy')
    `);
    await database.pool.query(`
      UPDATE platform_runtime_settings
      SET webhooks_enabled = false, librarian_enabled = true, distill_model = 'legacy'
      WHERE id = 'singleton'
    `);
    const before = await database.pool.query(
      "SELECT * FROM platform_runtime_settings WHERE id = 'singleton'",
    );

    await applyMainMigration(database.db, "0360_workspace_integrity_limits");
    const after = await database.pool.query(
      "SELECT * FROM platform_runtime_settings WHERE id = 'singleton'",
    );
    expect(before.rows).toHaveLength(1);
    expect(after.rows).toEqual([
      {
        ...before.rows[0],
        workspace_integrity_max_size_mib: null,
        workspace_integrity_max_duration_seconds: null,
        workspace_integrity_max_entries: null,
      },
    ]);

    for (const [column, max] of [
      ["workspace_integrity_max_size_mib", 8192],
      ["workspace_integrity_max_duration_seconds", 240],
      ["workspace_integrity_max_entries", 500000],
    ] as const) {
      for (const value of [1, max, null])
        await database.db.execute(
          sql`UPDATE platform_runtime_settings SET ${sql.identifier(column)} = ${value}`,
        );
      for (const value of [0, max + 1])
        await expect(
          database.pool.query(
            `UPDATE platform_runtime_settings SET ${column} = $1`,
            [value],
          ),
        ).rejects.toMatchObject({ code: "23514" });
    }
  } finally {
    await database.stop();
  }
}, 120_000);
