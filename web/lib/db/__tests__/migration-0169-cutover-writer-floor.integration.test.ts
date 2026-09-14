// S4.7 / D9 step 10: after the guarded cut-over the invariants the importer
// proved once become permanent, and a writer that predates them cannot create
// invalid state. A `complete` preservation lane record must carry its proof, a
// proven lane is final, and the lane table accepts writes only from a session
// that declares the writer capability this schema floor requires — an old
// binary never does, so it is refused by class rather than trusted by default.

import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildClient } from "@/lib/db/client";
import {
  EXECUTION_AB_WRITER_CAPABILITY,
  WRITER_CAPABILITY_SETTING,
} from "@/lib/db/writer-capability";
import {
  applyMainMigration,
  startMainPostgresTestDbUpTo,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const MIGRATION = "0169_cutover_writer_floor";
const LANES = [
  "events",
  "transcript",
  "cost",
  "runtime_objects",
  "scratch_session",
] as const;

let testDatabase: StartedPostgresTestDb;
let projectId: string;
const declaredClients: Client[] = [];

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDbUpTo(
    { databaseName: "cutover_writer_floor_0169_test" },
    "0168_needs_input_attention_index",
  );
  projectId = randomUUID();
  const short = projectId.replace(/-/g, "").slice(0, 8);

  await testDatabase.pool.query(
    `insert into projects (id, slug, name, repo_path, maister_yaml_path, task_key)
     values ($1, $2, $3, $4, '/tmp/m.yaml', $5)`,
    [
      projectId,
      `wf-${short}`,
      `WF ${short}`,
      `/tmp/wf-${short}`,
      `W${short.slice(0, 5).toUpperCase()}`,
    ],
  );
}, 240_000);

afterAll(async () => {
  for (const client of declaredClients.splice(0))
    await client.end().catch(() => undefined);
  await testDatabase?.stop();
});

async function seedRun(): Promise<string> {
  const runId = randomUUID();

  // After 0136 the only admissible mode is canonical, which is what a run that
  // lives on past the cut-over carries.
  await testDatabase.pool.query(
    `insert into runs (id, project_id, run_kind, status, flow_version, flow_revision)
     values ($1, $2, 'scratch', 'Done', 'scratch', 'manual')`,
    [runId, projectId],
  );

  return runId;
}

async function seedCompleteLanes(
  runId: string,
  proven: boolean,
): Promise<void> {
  for (const lane of LANES) {
    await testDatabase.pool.query(
      `insert into execution_data_plane_imports
        (run_id, source_kind, state, source_fingerprint, last_source_position,
         imported_count, last_error, started_at, completed_at, attempts)
       values ($1, $2, 'complete', $3, $4, 1, null, now(), now(), $5)`,
      [
        runId,
        lane,
        proven ? "a".repeat(64) : null,
        proven ? "items:1;bytes:1" : null,
        proven ? 1 : 0,
      ],
    );
  }
}

async function laneRows(
  runId: string,
): Promise<Array<{ state: string; fingerprint: string | null }>> {
  const rows = await testDatabase.pool.query<{
    state: string;
    fingerprint: string | null;
  }>(
    `select state, source_fingerprint as fingerprint from execution_data_plane_imports
     where run_id = $1 order by source_kind`,
    [runId],
  );

  return rows.rows;
}

async function floorObjects(): Promise<{
  constraints: string[];
  triggers: string[];
}> {
  const constraints = await testDatabase.pool.query<{ name: string }>(
    `select constraint_name as name from information_schema.table_constraints
     where table_name = 'execution_data_plane_imports'
       and constraint_name = 'execution_data_plane_imports_complete_proof_check'`,
  );
  const triggers = await testDatabase.pool.query<{ name: string }>(
    `select tgname as name from pg_trigger
     where tgrelid = 'execution_data_plane_imports'::regclass
       and tgname in ('execution_data_plane_imports_writer_gate',
                      'execution_data_plane_imports_complete_is_final')
     order by tgname`,
  );

  return {
    constraints: constraints.rows.map((row) => row.name),
    triggers: triggers.rows.map((row) => row.name),
  };
}

// A writer that declares a capability on its session — what the web client, the
// migrator and the import CLI do on connect.
async function declaredWriter(capability: string): Promise<Client> {
  const client = new Client({ connectionString: testDatabase.databaseUrl });

  await client.connect();
  await client.query(`SET ${WRITER_CAPABILITY_SETTING} = '${capability}'`);
  declaredClients.push(client);

  return client;
}

describe("0169_cutover_writer_floor", () => {
  it("refuses to apply while a complete lane record carries no proof, and alters nothing", async () => {
    const runId = await seedRun();

    await seedCompleteLanes(runId, false);

    await expect(
      applyMainMigration(testDatabase.db, MIGRATION),
    ).rejects.toThrow(/complete lane record\(s\) without proof/);

    // The rows are exactly as they were and no part of the floor was installed:
    // the repair path is loud and explicit, never a silent relabel.
    expect(await laneRows(runId)).toEqual(
      LANES.map(() => ({ state: "complete", fingerprint: null })),
    );
    expect(await floorObjects()).toEqual({ constraints: [], triggers: [] });

    await testDatabase.pool.query("delete from runs where id = $1", [runId]);
  });

  it("applies over proven lanes and installs the floor", async () => {
    const runId = await seedRun();

    await seedCompleteLanes(runId, true);
    await applyMainMigration(testDatabase.db, MIGRATION);

    expect(await floorObjects()).toEqual({
      constraints: ["execution_data_plane_imports_complete_proof_check"],
      triggers: [
        "execution_data_plane_imports_complete_is_final",
        "execution_data_plane_imports_writer_gate",
      ],
    });
    expect(await laneRows(runId)).toEqual(
      LANES.map(() => ({ state: "complete", fingerprint: "a".repeat(64) })),
    );
  });

  it("refuses a writer that declares no capability, naming its class", async () => {
    const runId = await seedRun();

    // The raw pool is exactly an old binary: it never heard of the setting.
    await expect(
      testDatabase.pool.query(
        `insert into execution_data_plane_imports (run_id, source_kind) values ($1, 'events')`,
        [runId],
      ),
    ).rejects.toThrow(/writer_class=undeclared/);
    await expect(
      testDatabase.pool.query(
        `update execution_data_plane_imports set attempts = attempts + 1 where state = 'complete'`,
      ),
    ).rejects.toThrow(/writer_class=undeclared/);
    expect(await laneRows(runId)).toEqual([]);
  });

  it("refuses a writer that declares a class below the floor", async () => {
    const runId = await seedRun();
    const stale = await declaredWriter("execution-ab-0");

    await expect(
      stale.query(
        `insert into execution_data_plane_imports (run_id, source_kind) values ($1, 'events')`,
        [runId],
      ),
    ).rejects.toThrow(/writer_class=execution-ab-0/);
    expect(await laneRows(runId)).toEqual([]);
  });

  it("accepts a declared writer and refuses a malformed or reopened complete record from it", async () => {
    const runId = await seedRun();
    const writer = await declaredWriter(EXECUTION_AB_WRITER_CAPABILITY);

    await writer.query(
      `insert into execution_data_plane_imports (run_id, source_kind) values ($1, 'events')`,
      [runId],
    );

    // A complete record without its proof is the false proof 0135 used to
    // refuse once; now the table refuses it for good.
    await expect(
      writer.query(
        `update execution_data_plane_imports set state = 'complete', completed_at = now()
         where run_id = $1 and source_kind = 'events'`,
        [runId],
      ),
    ).rejects.toMatchObject({
      constraint: "execution_data_plane_imports_complete_proof_check",
    });

    await writer.query(
      `update execution_data_plane_imports
       set state = 'complete', source_fingerprint = $2, last_source_position = 'items:1;bytes:1',
           started_at = now(), completed_at = now(), attempts = 1, last_error = null
       where run_id = $1 and source_kind = 'events'`,
      [runId, "b".repeat(64)],
    );

    // A proven lane is final: its state, fingerprint, position and count cannot
    // move, while operational counters still can.
    await expect(
      writer.query(
        `update execution_data_plane_imports set state = 'pending'
         where run_id = $1 and source_kind = 'events'`,
        [runId],
      ),
    ).rejects.toMatchObject({
      constraint: "execution_data_plane_imports_complete_is_final",
    });
    await expect(
      writer.query(
        `update execution_data_plane_imports set source_fingerprint = $2
         where run_id = $1 and source_kind = 'events'`,
        [runId, "c".repeat(64)],
      ),
    ).rejects.toMatchObject({
      constraint: "execution_data_plane_imports_complete_is_final",
    });
    await writer.query(
      `update execution_data_plane_imports set attempts = attempts + 1
       where run_id = $1 and source_kind = 'events'`,
      [runId],
    );
    expect(await laneRows(runId)).toEqual([
      { state: "complete", fingerprint: "b".repeat(64) },
    ]);
  });

  it("declares the capability on every connection the web client opens", async () => {
    const runId = await seedRun();
    const previous = process.env.DB_URL;

    process.env.DB_URL = testDatabase.databaseUrl;
    const db = buildClient();

    try {
      await db.execute(
        sql`insert into execution_data_plane_imports (run_id, source_kind) values (${runId}, 'events')`,
      );
      expect(await laneRows(runId)).toEqual([
        { state: "pending", fingerprint: null },
      ]);
    } finally {
      await db.$client.end();
      if (previous === undefined) delete process.env.DB_URL;
      else process.env.DB_URL = previous;
    }
  });
});
