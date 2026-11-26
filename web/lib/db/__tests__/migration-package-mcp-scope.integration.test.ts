import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, expect, it } from "vitest";

import { seedProjectRow } from "@/test-support/execution-host-seed";
import { upgradeMainTestDb } from "@/test-support/migration-upgrade";
import {
  startMainPostgresTestDbUpTo,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const baseline = "0401_stage_c_permanent_host_loss";
let database: StartedPostgresTestDb;

beforeAll(async () => {
  database = await startMainPostgresTestDbUpTo(
    { databaseName: "package_scope_upgrade" },
    baseline,
  );
  const project = await seedProjectRow(database.db);

  await database.pool.query(
    "INSERT INTO package_installs(id,source_url,name,version_label,resolved_revision,manifest,manifest_digest,installed_path) VALUES('base','fixture','core','v1','pin','{}','digest','/fixture')",
  );
  await database.pool.query(
    "INSERT INTO project_package_attachments(id,project_id,package_install_id,package_name) VALUES('old',$1,'base','core')",
    [project.id],
  );
  await upgradeMainTestDb(database, baseline);
}, 180_000);
afterAll(async () => {
  await database?.stop();
});

it("preserves populated attachment pins and enforces sparse scoped override integrity on migration replay", async () => {
  await migrate(database.db, { migrationsFolder: "./lib/db/migrations" });
  const { pool } = database;

  expect(
    (
      await pool.query(
        "SELECT id,package_install_id,scope_revision FROM project_package_attachments",
      )
    ).rows,
  ).toEqual([{ id: "old", package_install_id: "base", scope_revision: 1 }]);
  expect(
    (await pool.query("SELECT * FROM project_package_mcp_scope_overrides"))
      .rows,
  ).toEqual([]);
  const insert = (
    attachment: string,
    scope: string | null,
    refId = "design.figma-v1",
  ) =>
    pool.query(
      "INSERT INTO project_package_mcp_scope_overrides(attachment_id,ref_id,scope) VALUES($1,$2,$3)",
      [attachment, refId, scope],
    );

  await expect(insert("absent", "package")).rejects.toMatchObject({
    code: "23503",
  });
  await expect(insert("old", "elsewhere")).rejects.toMatchObject({
    code: "23514",
  });
  await expect(insert("old", null)).rejects.toMatchObject({ code: "23502" });
  for (const invalidRef of [
    "",
    ".",
    "some..ref",
    "some/ref",
    "a".repeat(129),
  ]) {
    await expect(insert("old", "package", invalidRef)).rejects.toMatchObject({
      code: "23514",
      constraint: "project_package_mcp_scope_ref_check",
    });
  }
  await insert("old", "project");
  await expect(insert("old", "package")).rejects.toMatchObject({
    code: "23505",
  });
  await pool.query("DELETE FROM project_package_attachments WHERE id='old'");
  expect(
    (await pool.query("SELECT * FROM project_package_mcp_scope_overrides"))
      .rows,
  ).toEqual([]);
});
