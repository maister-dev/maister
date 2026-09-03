// ADR-164 T1.3 — migration 0128_execution_hosts against a DB with history
// (M1–M3): additive, never data-dependent, constraints + partial indexes
// present, historical rows keep every new column NULL.

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  applyMainMigration,
  startMainPostgresTestDbUpTo,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const RUN_STATUSES = [
  "Pending",
  "Running",
  "NeedsInput",
  "NeedsInputIdle",
  "HumanWorking",
  "WaitingOnChildren",
  "Review",
  "Crashed",
  "Done",
  "Abandoned",
  "Failed",
] as const;

let testDatabase: StartedPostgresTestDb;
const runIds: string[] = [];

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDbUpTo(
    { databaseName: "eh_migration_0128_test" },
    "0127_output_contract",
  );
  const { pool } = testDatabase;
  const projectId = randomUUID();
  const short = projectId.replace(/-/g, "").slice(0, 8);

  await pool.query(
    `insert into projects (id, slug, name, repo_path, maister_yaml_path, task_key)
     values ($1, $2, $3, $4, '/tmp/m.yaml', $5)`,
    [
      projectId,
      `m128-${short}`,
      `M128 ${short}`,
      `/tmp/m128-${short}`,
      `M${short.slice(0, 5).toUpperCase()}`,
    ],
  );

  for (const status of RUN_STATUSES) {
    const runId = randomUUID();

    runIds.push(runId);
    await pool.query(
      `insert into runs (id, project_id, run_kind, status, flow_version, flow_revision)
       values ($1, $2, 'scratch', $3, 'scratch', 'manual')`,
      [runId, projectId, status],
    );
    await pool.query(
      `insert into run_sessions (id, run_id, session_name, acp_session_id)
       values ($1, $2, 'default', $3)`,
      [randomUUID(), runId, `acp-${short}`],
    );
    await pool.query(
      `insert into node_attempts (id, run_id, node_id, node_type, attempt, status)
       values ($1, $2, 'plan', 'ai_coding', 1, 'Succeeded')`,
      [randomUUID(), runId],
    );
  }

  await applyMainMigration(testDatabase.db, "0128_execution_hosts");
}, 240_000);

afterAll(async () => {
  await testDatabase?.stop();
});

async function count(table: string): Promise<number> {
  const { rows } = await testDatabase.pool.query(
    `select count(*)::int as n from ${table}`,
  );

  return rows[0].n;
}

describe("0128_execution_hosts", () => {
  it("M1: additive — row counts unchanged, new columns NULL, constraints + partial indexes present", async () => {
    expect(await count("runs")).toBe(RUN_STATUSES.length);
    expect(await count("run_sessions")).toBe(RUN_STATUSES.length);
    expect(await count("node_attempts")).toBe(RUN_STATUSES.length);

    const nulls = await testDatabase.pool.query(
      `select
         (select count(*)::int from runs where execution_assignment_id is not null) as runs_set,
         (select count(*)::int from run_sessions where execution_assignment_id is not null or host_session_id is not null) as sessions_set,
         (select count(*)::int from node_attempts where execution_assignment_id is not null) as attempts_set`,
    );

    expect(nulls.rows[0]).toEqual({
      runs_set: 0,
      sessions_set: 0,
      attempts_set: 0,
    });

    // Postgres truncates identifiers to 63 bytes (NAMEDATALEN-1): four of the
    // drizzle-convention FK names are longer, so assert the STORED names.
    const constraints = await testDatabase.pool.query(
      `select conname from pg_constraint where conname = any($1::text[]) order by conname`,
      [
        [
          "execution_hosts_host_key_unique",
          "execution_hosts_kind_check",
          "execution_hosts_readiness_check",
          "execution_assignments_run_epoch_uq",
          "execution_assignments_epoch_check",
          "execution_assignments_state_check",
          "execution_assignments_placement_reason_check",
          "execution_assignments_active_shape_check",
          "execution_commands_kind_check",
          "execution_commands_state_check",
          "execution_commands_terminal_shape_check",
          "execution_assignments_run_id_runs_id_fk",
          "execution_assignments_execution_host_id_execution_hosts_id_fk",
          "execution_assignments_superseded_by_id_execution_assignments_id_fk",
          "execution_commands_run_id_runs_id_fk",
          "execution_commands_execution_assignment_id_execution_assignments_id_fk",
          "execution_commands_execution_host_id_execution_hosts_id_fk",
          "runs_execution_assignment_id_execution_assignments_id_fk",
          "run_sessions_execution_assignment_id_execution_assignments_id_fk",
          "node_attempts_execution_assignment_id_execution_assignments_id_fk",
        ].map((name) => name.slice(0, 63)),
      ],
    );

    expect(constraints.rows).toHaveLength(20);

    const indexes = await testDatabase.pool.query(
      `select indexname, indexdef from pg_indexes where indexname = any($1::text[]) order by indexname`,
      [
        [
          "execution_hosts_local_active_uq",
          "execution_assignments_run_active_uq",
          "execution_assignments_host_state_idx",
          "execution_commands_open_idx",
          "execution_commands_run_created_idx",
          "execution_commands_assignment_idx",
          "runs_execution_assignment_idx",
          "run_sessions_host_session_idx",
          "run_sessions_assignment_idx",
          "node_attempts_assignment_idx",
        ],
      ],
    );
    const byName = new Map<string, string>(
      indexes.rows.map((r: { indexname: string; indexdef: string }) => [
        r.indexname,
        r.indexdef,
      ]),
    );

    expect(byName.size).toBe(10);
    expect(byName.get("execution_hosts_local_active_uq")).toMatch(
      /CREATE UNIQUE INDEX .* WHERE \(\(kind = 'local_direct'::text\) AND \(retired_at IS NULL\)\)/,
    );
    expect(byName.get("execution_assignments_run_active_uq")).toMatch(
      /CREATE UNIQUE INDEX .* WHERE \(state = 'active'::text\)/,
    );
    expect(byName.get("execution_commands_open_idx")).toMatch(
      /WHERE \(state = ANY \(ARRAY\['queued'::text, 'delivering'::text, 'accepted'::text\]\)\)/,
    );
  });

  it("M2: a second non-retired local_direct host violates the partial unique index", async () => {
    const { pool } = testDatabase;

    await pool.query(
      `insert into execution_hosts (id, host_key, kind, display_name, transport)
       values ($1, 'eh_first', 'local_direct', 'first', '{"kind":"local_direct"}')`,
      [randomUUID()],
    );

    await expect(
      pool.query(
        `insert into execution_hosts (id, host_key, kind, display_name, transport)
         values ($1, 'eh_second', 'local_direct', 'second', '{"kind":"local_direct"}')`,
        [randomUUID()],
      ),
    ).rejects.toMatchObject({ code: "23505" });

    // Retiring the first frees the slot.
    await pool.query(
      `update execution_hosts set retired_at = now() where host_key = 'eh_first'`,
    );
    await pool.query(
      `insert into execution_hosts (id, host_key, kind, display_name, transport)
       values ($1, 'eh_second', 'local_direct', 'second', '{"kind":"local_direct"}')`,
      [randomUUID()],
    );
  });

  it("M3: the active-shape CHECK rejects an active row with ended_at and a terminal row without it", async () => {
    const { pool } = testDatabase;
    const host = await pool.query(
      `select id from execution_hosts where retired_at is null limit 1`,
    );
    const hostId = host.rows[0].id as string;
    const runId = runIds[0];

    await expect(
      pool.query(
        `insert into execution_assignments (id, run_id, execution_host_id, epoch, state, placement_reason, ended_at)
         values ($1, $2, $3, 1, 'active', 'launch', now())`,
        [randomUUID(), runId, hostId],
      ),
    ).rejects.toMatchObject({ code: "23514" });

    await expect(
      pool.query(
        `insert into execution_assignments (id, run_id, execution_host_id, epoch, state, placement_reason)
         values ($1, $2, $3, 1, 'released', 'launch')`,
        [randomUUID(), runId, hostId],
      ),
    ).rejects.toMatchObject({ code: "23514" });

    await pool.query(
      `insert into execution_assignments (id, run_id, execution_host_id, epoch, state, placement_reason)
       values ($1, $2, $3, 1, 'active', 'launch')`,
      [randomUUID(), runId, hostId],
    );
  });
});
