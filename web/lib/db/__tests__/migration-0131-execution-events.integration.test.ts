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
let streamId: string;

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDbUpTo(
    { databaseName: "execution_events_migration_0131_test" },
    "0130_execution_hosts",
  );
  const projectId = randomUUID();

  runId = randomUUID();
  hostId = randomUUID();
  streamId = randomUUID();

  await testDatabase.pool.query(
    `insert into projects (id, slug, name, repo_path, maister_yaml_path, task_key)
     values ($1, 'events-0131', 'Events 0131', '/tmp/events-0131', '/tmp/events-0131/maister.yaml', 'EVT0131')`,
    [projectId],
  );
  await testDatabase.pool.query(
    `insert into runs (id, project_id, run_kind, status, flow_version, flow_revision)
     values ($1, $2, 'scratch', 'Pending', 'scratch', 'manual')`,
    [runId, projectId],
  );
  await testDatabase.pool.query(
    `insert into execution_hosts (id, host_key, kind, display_name, transport)
     values ($1, 'eh_0131host', 'local_direct', '0131 host', '{"kind":"local_direct"}')`,
    [hostId],
  );
  await applyMainMigration(testDatabase.db, "0131_foamy_venom");
  await applyMainMigration(testDatabase.db, "0132_soft_loa");
}, 240_000);

afterAll(async () => {
  await testDatabase?.stop();
});

describe("0131_foamy_venom canonical event schema", () => {
  it("backfills every historical run into explicitly preserved import lanes", async () => {
    const result = await testDatabase.pool.query(
      `select execution_data_plane_mode as mode,
              (select count(*)::int from execution_data_plane_imports where run_id = $1) as imports
       from runs where id = $1`,
      [runId],
    );

    expect(result.rows[0]).toEqual({ mode: "legacy_file_v1", imports: 5 });
    await expect(
      testDatabase.pool.query(
        `update runs set execution_data_plane_mode = 'canonical_events_v1' where id = $1`,
        [runId],
      ),
    ).rejects.toMatchObject({ code: "P0001" });
  });

  it("enforces source shape, host-position idempotency, and bounded canonical fields", async () => {
    await testDatabase.pool.query(
      `insert into execution_event_streams (id, execution_host_id, stream_id, state)
       values ($1, $2, $3, 'active')`,
      [randomUUID(), hostId, streamId],
    );
    const stream = await testDatabase.pool.query(
      `select id from execution_event_streams where execution_host_id = $1 and stream_id = $2`,
      [hostId, streamId],
    );
    const eventStreamId = stream.rows[0].id as string;
    const values = [
      randomUUID(),
      runId,
      hostId,
      eventStreamId,
      "89c8d1f2-0c56-4d0b-9467-a4b4b8f0c98c",
    ];

    await testDatabase.pool.query(
      `insert into execution_events
        (id, source, run_id, execution_host_id, event_stream_id, host_sequence,
         host_boot_id, envelope_version, event_type, payload_schema, payload_bytes,
         occurred_at, run_sequence, ingest_disposition)
       values ($1, 'host', $2, $3, $4, 0, $5, 1, 'session.created',
               'maister.session.created.v1', 0, now(), 0, 'accepted')`,
      values,
    );

    await expect(
      testDatabase.pool.query(
        `insert into execution_events
          (id, source, run_id, execution_host_id, event_stream_id, host_sequence,
           host_boot_id, envelope_version, event_type, payload_schema, occurred_at,
           ingest_disposition)
         values ($1, 'host', $2, $3, $4, 0, $5, 1, 'session.created',
                 'maister.session.created.v1', now(), 'accepted')`,
        [randomUUID(), ...values.slice(1)],
      ),
    ).rejects.toMatchObject({ code: "23505" });

    await expect(
      testDatabase.pool.query(
        `insert into execution_events
          (id, source, run_id, event_type, payload_schema, occurred_at, ingest_disposition)
         values ($1, 'manager', $2, 'manager.notice', 'maister.manager.notice.v1', now(), 'accepted')`,
        [randomUUID(), runId],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });
});
