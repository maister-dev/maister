// A prompt only terminalizes from an INGESTED terminal event. When ingest is
// dead the command sits in `accepted` forever, the driver yields every sweep,
// and the only trace was a silent `skippedInFlight` counter — which is why the
// 2026-09-16 incident looked like a stuck agent rather than a stopped stream.
// Nothing here writes command state: the driver does not own the outcome. The
// point is that the impasse becomes visible.
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  commandStreamLost,
  lostStreamHostIds,
} from "@/lib/execution-host/events/stream-health";
import { recoverExecutionCommands } from "@/lib/execution-host/recovery";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

let testDatabase: StartedPostgresTestDb;
let hostId: string;
let runId: string;
let assignmentId: string;
let commandId: string;
let streamRowId: string;

const SHA = "a".repeat(64);

async function setStreamState(state: "active" | "lost"): Promise<void> {
  await testDatabase.pool.query(
    `update execution_event_streams set state = $2 where id = $1`,
    [streamRowId, state],
  );
}

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "command_impasse_test",
  });
  const projectId = randomUUID();

  hostId = randomUUID();
  runId = randomUUID();
  assignmentId = randomUUID();
  commandId = randomUUID();
  streamRowId = randomUUID();

  await testDatabase.pool.query(
    `insert into projects (id, slug, name, repo_path, maister_yaml_path, task_key)
     values ($1, 'impasse', 'Impasse', '/tmp/impasse', '/tmp/impasse/maister.yaml', 'IMP')`,
    [projectId],
  );
  await testDatabase.pool.query(
    `insert into runs (id, project_id, run_kind, status, flow_version, flow_revision)
     values ($1, $2, 'flow', 'Running', 'flow', 'manual')`,
    [runId, projectId],
  );
  await testDatabase.pool.query(
    `insert into execution_hosts (id, host_key, kind, display_name, transport, readiness)
     values ($1, $2, 'local_direct', 'impasse host', '{"kind":"local_direct"}', 'ready')`,
    [hostId, `eh_${randomUUID().replace(/-/g, "")}`],
  );
  await testDatabase.pool.query(
    `insert into execution_assignments
       (id, run_id, execution_host_id, epoch, state, placement_reason)
     values ($1, $2, $3, 1, 'active', 'launch')`,
    [assignmentId, runId, hostId],
  );
  await testDatabase.pool.query(
    `update runs set execution_assignment_id = $1 where id = $2`,
    [assignmentId, runId],
  );
  await testDatabase.pool.query(
    `insert into execution_event_streams
       (id, execution_host_id, stream_id, state, last_seen_at)
     values ($1, $2, $3, 'active', now())`,
    [streamRowId, hostId, randomUUID()],
  );
  await testDatabase.pool.query(
    `insert into execution_commands
       (id, run_id, execution_host_id, execution_assignment_id, assignment_epoch,
        kind, state, max_attempts, accepted_at, transport_state,
        owner_kind, owner_ref, logical_operation_key, request_schema, request_sha256,
        created_at, updated_at)
     values ($1, $2, $3, $4, 1, 'session.prompt', 'accepted', 1,
             now() - interval '10 minutes', 'acknowledged',
             'flow_node_attempt', $5, 'impasse-op', 'maister.command.request.v1', $6,
             now() - interval '10 minutes', now() - interval '10 minutes')`,
    [
      commandId,
      runId,
      hostId,
      assignmentId,
      JSON.stringify({
        kind: "flow_node_attempt",
        nodeAttemptId: randomUUID(),
      }),
      SHA,
    ],
  );
}, 240_000);

afterAll(async () => {
  await testDatabase?.stop();
});

describe("command impasse on a lost event stream", () => {
  it("does not treat a healthy stream as an impasse", async () => {
    await setStreamState("active");

    expect(await commandStreamLost({ db: testDatabase.db, commandId })).toBe(
      false,
    );

    const summary = await recoverExecutionCommands({
      db: testDatabase.db,
      transport: {
        getCommandReceipt: async () => null,
      } as never,
    });

    expect(summary.impasse).toBe(0);
  });

  it("counts and reports an accepted prompt whose stream is lost", async () => {
    await setStreamState("lost");

    expect(await commandStreamLost({ db: testDatabase.db, commandId })).toBe(
      true,
    );
    expect([...(await lostStreamHostIds({ db: testDatabase.db }))]).toEqual([
      hostId,
    ]);

    const summary = await recoverExecutionCommands({
      db: testDatabase.db,
      transport: {
        getCommandReceipt: async () => null,
      } as never,
    });

    expect(summary.impasse).toBe(1);
    // The command is NOT terminalized: only its owner may decide that.
    const { rows } = await testDatabase.pool.query(
      `select state from execution_commands where id = $1`,
      [commandId],
    );

    expect(rows[0].state).toBe("accepted");
  });
});
