// ADR-167 B4: migration ordering must reject unpreserved legacy runtime
// associations before it drops their cursor table or makes canonical mode the
// only admissible value.

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  applyMainMigration,
  startMainPostgresTestDbUpTo,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

let testDatabase: StartedPostgresTestDb;
let runId: string;

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDbUpTo(
    { databaseName: "canonical_data_plane_cutover_0135_test" },
    "0134_lovely_tarot",
  );
  const projectId = randomUUID();

  runId = randomUUID();
  const short = projectId.replace(/-/g, "").slice(0, 8);

  await testDatabase.pool.query(
    `insert into projects (id, slug, name, repo_path, maister_yaml_path, task_key)
     values ($1, $2, $3, $4, '/tmp/m.yaml', $5)`,
    [
      projectId,
      `m135-${short}`,
      `M135 ${short}`,
      `/tmp/m135-${short}`,
      `M${short.slice(0, 5).toUpperCase()}`,
    ],
  );
  await testDatabase.pool.query(
    `insert into runs
      (id, project_id, run_kind, status, flow_version, flow_revision, execution_data_plane_mode)
     values ($1, $2, 'scratch', 'Done', 'scratch', 'manual', 'legacy_file_v1')`,
    [runId, projectId],
  );
}, 240_000);

afterAll(async () => {
  await testDatabase?.stop();
});

describe("0135_lush_jetstream and 0136_shiny_the_executioner", () => {
  it("fails closed before dropping legacy projection cursors", async () => {
    await expect(
      applyMainMigration(testDatabase.db, "0135_lush_jetstream"),
    ).rejects.toThrow(/five complete preservation proof records/);

    const table = await testDatabase.pool.query(
      `select 1 from information_schema.tables
       where table_name = 'artifact_projection_cursors'`,
    );

    expect(table.rows).toHaveLength(1);
  });

  it("rejects nominal completion rows that lack durable proof", async () => {
    await testDatabase.pool.query(
      `insert into execution_data_plane_imports
        (run_id, source_kind, state, completed_at)
       select $1, source_kind, 'complete', now()
       from (values ('events'), ('transcript'), ('cost'), ('runtime_objects'), ('scratch_session')) as kinds(source_kind)
       on conflict (run_id, source_kind) do update
       set state = 'complete', completed_at = now()`,
      [runId],
    );

    await expect(
      applyMainMigration(testDatabase.db, "0135_lush_jetstream"),
    ).rejects.toThrow(/complete preservation proof/);
  });

  it("removes the cursor only after preservation and rejects future legacy modes", async () => {
    await testDatabase.pool.query(
      `update execution_data_plane_imports
       set state = 'complete',
           source_fingerprint = 'verified-fixture',
           last_source_position = 'complete',
           imported_count = 0,
           last_error = null,
           started_at = now(),
           completed_at = now(),
           attempts = 1
       where run_id = $1`,
      [runId],
    );

    await applyMainMigration(testDatabase.db, "0135_lush_jetstream");
    await applyMainMigration(testDatabase.db, "0136_shiny_the_executioner");

    const mode = await testDatabase.pool.query(
      `select execution_data_plane_mode as mode from runs where id = $1`,
      [runId],
    );

    expect(mode.rows).toEqual([{ mode: "canonical_events_v1" }]);

    const table = await testDatabase.pool.query(
      `select 1 from information_schema.tables
       where table_name = 'artifact_projection_cursors'`,
    );

    expect(table.rows).toHaveLength(0);
    await expect(
      testDatabase.pool.query(
        `update runs set execution_data_plane_mode = 'legacy_file_v1' where id = $1`,
        [runId],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });
});
