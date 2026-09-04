// ADR-167 T3.4: prove the runtime-object catalogue is additive on a populated
// Stage-B event-plane database and that its path-free metadata invariants are
// enforced by Postgres rather than an optional application convention.

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  applyMainMigration,
  startMainPostgresTestDbUpTo,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

let testDatabase: StartedPostgresTestDb;
let runId: string;
let hostId: string;

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDbUpTo(
    { databaseName: "eh_migration_0133_test" },
    "0132_soft_loa",
  );
  const projectId = randomUUID();
  const short = projectId.replace(/-/g, "").slice(0, 8);
  runId = randomUUID();
  hostId = randomUUID();

  await testDatabase.pool.query(
    `insert into projects (id, slug, name, repo_path, maister_yaml_path, task_key)
     values ($1, $2, $3, $4, '/tmp/m.yaml', $5)`,
    [
      projectId,
      `m133-${short}`,
      `M133 ${short}`,
      `/tmp/m133-${short}`,
      `M${short.slice(0, 5).toUpperCase()}`,
    ],
  );
  await testDatabase.pool.query(
    `insert into runs (id, project_id, run_kind, status, flow_version, flow_revision, execution_data_plane_mode)
     values ($1, $2, 'scratch', 'Pending', 'scratch', 'canonical', 'canonical_events_v1')`,
    [runId, projectId],
  );
  await testDatabase.pool.query(
    `insert into execution_hosts (id, host_key, kind, display_name, transport)
     values ($1, $2, 'local_direct', 'migration host', '{"kind":"local_direct"}')`,
    [hostId, `eh_m133_${short}`],
  );
  await applyMainMigration(testDatabase.db, "0133_rich_blob");
}, 240_000);

afterAll(async () => {
  await testDatabase?.stop();
});

describe("0133_rich_blob", () => {
  it("adds the opaque catalogue without changing existing run rows and rejects path-shaped or incomplete available metadata", async () => {
    const before = await testDatabase.pool.query(
      `select execution_data_plane_mode from runs where id = $1`,
      [runId],
    );
    expect(before.rows[0]).toEqual({ execution_data_plane_mode: "canonical_events_v1" });

    await testDatabase.pool.query(
      `insert into execution_runtime_objects
        (id, run_id, execution_host_id, kind, logical_name, mime_type, size_bytes, sha256, generation, retention_class, state, sealed_at)
       values ($1, $2, $3, 'evidence', 'report.json', 'application/json', 2, repeat('a', 64), 1, 'run', 'available', now())`,
      [randomUUID(), runId, hostId],
    );

    await expect(
      testDatabase.pool.query(
        `insert into execution_runtime_objects
          (id, run_id, execution_host_id, kind, logical_name, mime_type, generation, retention_class, state)
         values ($1, $2, $3, 'evidence', '../host-path', 'application/json', 1, 'run', 'missing')`,
        [randomUUID(), runId, hostId],
      ),
    ).rejects.toMatchObject({ code: "23514" });

    await expect(
      testDatabase.pool.query(
        `insert into execution_runtime_objects
          (id, run_id, execution_host_id, kind, logical_name, mime_type, generation, retention_class, state)
         values ($1, $2, $3, 'evidence', 'unsealed.json', 'application/json', 1, 'run', 'available')`,
        [randomUUID(), runId, hostId],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });
});
