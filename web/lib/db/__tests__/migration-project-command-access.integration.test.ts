import { afterAll, beforeAll, expect, it } from "vitest";

import {
  applyMainMigration,
  startMainPostgresTestDbUpTo,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

let database: StartedPostgresTestDb;

beforeAll(async () => {
  database = await startMainPostgresTestDbUpTo(
    { databaseName: "project_command_access_upgrade" },
    "0342_domain_event_run_pr_merged",
  );
  await database.pool.query(
    "INSERT INTO projects(id, slug, name, repo_path, task_key) VALUES ('legacy', 'legacy', 'Legacy', '/fixture/legacy', 'LEGACY')",
  );
  await applyMainMigration(database.db, "0343_project_command_access");
}, 180_000);

afterAll(async () => {
  await database?.stop();
});

it("preserves legacy projects and distinguishes an inherited profile from an empty grant", async () => {
  const read = () =>
    database.pool.query(
      "SELECT command_access_profile AS profile, command_access_revision AS revision FROM projects WHERE id = 'legacy'",
    );
  expect((await read()).rows).toEqual([{ profile: null, revision: 1 }]);
  await database.pool.query(
    "UPDATE projects SET command_access_profile = $1, command_access_revision = 2 WHERE id = 'legacy'",
    [JSON.stringify({ hostPortGrants: [] })],
  );
  expect((await read()).rows).toEqual([
    { profile: { hostPortGrants: [] }, revision: 2 },
  ]);
  await expect(
    database.pool.query(
      "UPDATE projects SET command_access_revision = 0 WHERE id = 'legacy'",
    ),
  ).rejects.toMatchObject({
    constraint: "projects_command_access_revision_positive",
  });
});
