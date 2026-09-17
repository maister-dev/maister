// The 2026-09-16 outage was invisible for 15 h because nothing read
// `last_seen_at`. A detector that only reads elapsed time would be worse than
// nothing here: there is no heartbeat event type and one stream row serves a
// whole host, so a quiet stand is normal. The stall is "open work produced no
// events", and the response is repair first, degrade only if repair failed.
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  findStalledEventStreams,
  reportPoisonedConsumers,
  runEventStreamHealthPass,
} from "@/lib/execution-host/events/stream-health";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

let testDatabase: StartedPostgresTestDb;
let projectId: string;
let runId: string;
let hostId: string;
let assignmentId: string;
let streamRowId: string;

const STALL_SECONDS = 300;

async function setLastSeen(ageSeconds: number): Promise<void> {
  await testDatabase.pool.query(
    `update execution_event_streams
        set last_seen_at = now() - ($2 || ' seconds')::interval, state = 'active', last_error = null
      where id = $1`,
    [streamRowId, String(ageSeconds)],
  );
}

async function setOpenCommand(open: boolean): Promise<void> {
  // A terminal row must carry its completion stamp (terminal_shape_check).
  await testDatabase.pool.query(
    open
      ? `update execution_commands set state = 'accepted', completed_at = null where run_id = $1`
      : `update execution_commands set state = 'succeeded', completed_at = now() where run_id = $1`,
    [runId],
  );
}

async function streamState(): Promise<string> {
  const { rows } = await testDatabase.pool.query(
    `select state from execution_event_streams where id = $1`,
    [streamRowId],
  );

  return rows[0].state as string;
}

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "execution_stream_health_test",
  });
  projectId = randomUUID();
  runId = randomUUID();
  hostId = randomUUID();
  assignmentId = randomUUID();
  streamRowId = randomUUID();

  await testDatabase.pool.query(
    `insert into projects (id, slug, name, repo_path, maister_yaml_path, task_key)
     values ($1, 'stream-health', 'Stream health', '/tmp/stream-health', '/tmp/stream-health/maister.yaml', 'SH')`,
    [projectId],
  );
  await testDatabase.pool.query(
    `insert into runs (id, project_id, run_kind, status, flow_version, flow_revision)
     values ($1, $2, 'scratch', 'Running', 'scratch', 'manual')`,
    [runId, projectId],
  );
  await testDatabase.pool.query(
    `insert into execution_hosts (id, host_key, kind, display_name, transport, readiness)
     values ($1, $2, 'local_direct', 'stream health host', '{"kind":"local_direct"}', 'ready')`,
    [hostId, `eh_${randomUUID().replace(/-/g, "")}`],
  );
  await testDatabase.pool.query(
    `insert into execution_assignments
       (id, run_id, execution_host_id, epoch, state, placement_reason)
     values ($1, $2, $3, 1, 'active', 'launch')`,
    [assignmentId, runId, hostId],
  );
  await testDatabase.pool.query(
    `insert into execution_event_streams
       (id, execution_host_id, stream_id, state, last_seen_at)
     values ($1, $2, $3, 'active', now())`,
    [streamRowId, hostId, randomUUID()],
  );
  // A non-prompt kind keeps the owner-shape constraint out of this fixture: the
  // stall predicate counts any open command, not only prompts.
  await testDatabase.pool.query(
    `insert into execution_commands
       (id, run_id, execution_host_id, execution_assignment_id, assignment_epoch,
        kind, state, max_attempts)
     values ($1, $2, $3, $4, 1, 'session.checkpoint', 'accepted', 1)`,
    [randomUUID(), runId, hostId, assignmentId],
  );
}, 240_000);

afterAll(async () => {
  await testDatabase?.stop();
});

describe("execution event stream health", () => {
  it("ignores a quiet host with no open work", async () => {
    await setLastSeen(STALL_SECONDS * 4);
    await setOpenCommand(false);

    expect(
      await findStalledEventStreams({
        db: testDatabase.db,
        stallSeconds: STALL_SECONDS,
      }),
    ).toEqual([]);
  });

  it("flags a stream whose open work produced no events", async () => {
    await setLastSeen(STALL_SECONDS * 4);
    await setOpenCommand(true);

    const stalled = await findStalledEventStreams({
      db: testDatabase.db,
      stallSeconds: STALL_SECONDS,
    });

    expect(stalled).toHaveLength(1);
    expect(stalled[0].executionHostId).toBe(hostId);
    expect(stalled[0].openCommands).toBe(1);
  });

  it("ignores a stream that is merely younger than the stall window", async () => {
    await setLastSeen(10);
    await setOpenCommand(true);

    expect(
      await findStalledEventStreams({
        db: testDatabase.db,
        stallSeconds: STALL_SECONDS,
      }),
    ).toEqual([]);
  });

  it("restarts the consumer first and only degrades when repair did not help", async () => {
    await setLastSeen(STALL_SECONDS * 4);
    await setOpenCommand(true);
    const restarted: string[] = [];

    const first = await runEventStreamHealthPass({
      db: testDatabase.db,
      stallSeconds: STALL_SECONDS,
      restartConsumer: (host) => {
        restarted.push(host);
      },
    });

    expect(restarted).toEqual([hostId]);
    expect(first.stalled).toBe(1);
    expect(first.degraded).toBe(0);
    // Repair is not a verdict: the stream stays usable while it is retried.
    expect(await streamState()).toBe("active");

    const second = await runEventStreamHealthPass({
      db: testDatabase.db,
      stallSeconds: STALL_SECONDS,
      restartConsumer: (host) => {
        restarted.push(host);
      },
    });

    expect(second.degraded).toBe(1);
    expect(restarted).toEqual([hostId]);
    expect(await streamState()).toBe("lost");
  });

  it("reports a poisoned projection consumer instead of leaving it silent", async () => {
    await testDatabase.pool.query(
      `insert into execution_event_consumers
         (consumer_name, run_id, state, attempts, last_error, last_run_sequence)
       values ('canonical-run-transcript-v2', $1, 'poisoned', 5,
               '{"reason":"projection_failure"}'::jsonb, 30198)`,
      [runId],
    );

    const poisoned = await reportPoisonedConsumers({ db: testDatabase.db });

    expect(poisoned.count).toBe(1);
    expect(poisoned.errors[0]).toContain("canonical-run-transcript-v2");

    const pass = await runEventStreamHealthPass({
      db: testDatabase.db,
      stallSeconds: STALL_SECONDS,
      restartConsumer: () => {},
    });

    expect(pass.poisonedConsumers).toBe(1);
    expect(pass.errors.some((e) => e.includes("poisoned"))).toBe(true);

    await testDatabase.pool.query(
      `delete from execution_event_consumers where run_id = $1`,
      [runId],
    );
  });

  it("leaves a recovered stream alone after its restart worked", async () => {
    await testDatabase.pool.query(
      `update execution_event_streams set state = 'active' where id = $1`,
      [streamRowId],
    );
    await setLastSeen(STALL_SECONDS * 4);
    await setOpenCommand(true);

    await runEventStreamHealthPass({
      db: testDatabase.db,
      stallSeconds: STALL_SECONDS,
      restartConsumer: () => {},
    });
    // The restarted loop ingested something: last_seen_at moved forward.
    await setLastSeen(1);

    const after = await runEventStreamHealthPass({
      db: testDatabase.db,
      stallSeconds: STALL_SECONDS,
      restartConsumer: () => {},
    });

    expect(after.stalled).toBe(0);
    expect(after.degraded).toBe(0);
    expect(await streamState()).toBe("active");
  });
});
