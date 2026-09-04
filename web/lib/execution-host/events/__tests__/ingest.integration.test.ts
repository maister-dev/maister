import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ingestRuntimeEvent } from "@/lib/execution-host/events/ingest";
import { consumeRuntimeEventStreamOnce } from "@/lib/execution-host/events/consumer";
import {
  ExecutionEventProjectionError,
  projectExecutionEvents,
} from "@/lib/execution-host/events/projector";
import type { ExecutionHostTransport } from "@/lib/execution-host/contracts";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

let testDatabase: StartedPostgresTestDb;
let runId: string;
let hostId: string;
let assignmentId: string;
let staleAssignmentId: string;
let hostKey: string;
let streamId: string;

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "execution_event_ingest_test",
  });
  const projectId = randomUUID();
  runId = randomUUID();
  hostId = randomUUID();
  assignmentId = randomUUID();
  staleAssignmentId = randomUUID();
  hostKey = `eh_${randomUUID().replace(/-/g, "")}`;
  streamId = randomUUID();

  await testDatabase.pool.query(
    `insert into projects (id, slug, name, repo_path, maister_yaml_path, task_key)
     values ($1, 'event-ingest', 'Event ingest', '/tmp/event-ingest', '/tmp/event-ingest/maister.yaml', 'EVT-INGEST')`,
    [projectId],
  );
  await testDatabase.pool.query(
    `insert into runs (id, project_id, run_kind, status, flow_version, flow_revision)
     values ($1, $2, 'scratch', 'Pending', 'scratch', 'manual')`,
    [runId, projectId],
  );
  await testDatabase.pool.query(
    `insert into execution_hosts (id, host_key, kind, display_name, transport)
     values ($1, $2, 'local_direct', 'event ingest host', '{"kind":"local_direct"}')`,
    [hostId, hostKey],
  );
  await testDatabase.pool.query(
    `insert into execution_assignments
       (id, run_id, execution_host_id, epoch, state, placement_reason)
     values ($1, $2, $3, 1, 'active', 'launch')`,
    [assignmentId, runId, hostId],
  );
  await testDatabase.pool.query(
    `insert into execution_assignments
       (id, run_id, execution_host_id, epoch, state, placement_reason, ended_at, released_reason)
     values ($1, $2, $3, 2, 'released', 'recover', now(), 'test_stale_epoch')`,
    [staleAssignmentId, runId, hostId],
  );
}, 240_000);

afterAll(async () => {
  await testDatabase?.stop();
});

function event(sequence: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    envelopeVersion: 1,
    eventId: randomUUID(),
    hostKey,
    hostBootId: randomUUID(),
    streamId,
    sequence,
    runId,
    assignmentId,
    assignmentEpoch: 1,
    hostSessionId: randomUUID(),
    eventType: "session.update",
    occurredAt: "2026-09-04T00:00:00.000Z",
    payloadSchema: "maister.session.update.v1",
    payload: { update: { state: "working" } },
    ...overrides,
  };
}

describe("runtime event ingestion", () => {
  it("persists at-least-once delivery exactly once and promotes a held gap in host order", async () => {
    const later = event("1");
    const first = event("0");
    const held = await ingestRuntimeEvent({
      db: testDatabase.db,
      executionHostId: hostId,
      envelope: later,
    });
    const promoted = await ingestRuntimeEvent({
      db: testDatabase.db,
      executionHostId: hostId,
      envelope: first,
    });
    const duplicate = await ingestRuntimeEvent({
      db: testDatabase.db,
      executionHostId: hostId,
      envelope: first,
    });
    const stored = await testDatabase.pool.query(
      `select id, host_sequence::text, run_sequence::text, ingest_disposition
       from execution_events where run_id = $1 order by host_sequence`,
      [runId],
    );

    expect(held).toMatchObject({ disposition: "pending_gap", contiguousThrough: null });
    expect(promoted).toMatchObject({ contiguousThrough: "1", acceptedCount: 2 });
    expect(duplicate).toMatchObject({ disposition: "duplicate", contiguousThrough: "1" });
    expect(stored.rows).toEqual([
      { id: first.eventId, host_sequence: "0", run_sequence: "0", ingest_disposition: "accepted" },
      { id: later.eventId, host_sequence: "1", run_sequence: "1", ingest_disposition: "accepted" },
    ]);
  });

  it("advances stale epochs only as audited stream history, never as a run sequence", async () => {
    const stale = event("2", {
      assignmentId: staleAssignmentId,
      assignmentEpoch: 2,
    });
    const result = await ingestRuntimeEvent({
      db: testDatabase.db,
      executionHostId: hostId,
      envelope: stale,
    });
    const stored = await testDatabase.pool.query(
      `select run_sequence, ingest_disposition, ingest_error
       from execution_events where id = $1`,
      [stale.eventId],
    );

    expect(result).toMatchObject({ disposition: "stale_epoch", contiguousThrough: "2", staleEpochCount: 1 });
    expect(stored.rows[0]).toEqual({
      run_sequence: null,
      ingest_disposition: "stale_epoch",
      ingest_error: { reason: "stale_assignment_epoch" },
    });
  });

  it("ACKs only after commit and reconciles an acknowledgement response loss from the durable watermark", async () => {
    const next = event("3");
    const acknowledgements: Array<{ streamId: string; throughSequence: string }> = [];
    const transport = {
      async *streamRuntimeEvents() {
        yield next;
      },
      async acknowledgeRuntimeEvents(input: { streamId: string; throughSequence: string }) {
        acknowledgements.push(input);
        return { streamId: input.streamId, acknowledgedThrough: input.throughSequence };
      },
    } as unknown as ExecutionHostTransport;
    const consumed = await consumeRuntimeEventStreamOnce({
      db: testDatabase.db,
      executionHostId: hostId,
      transport,
      owner: "test-consumer-a",
      maxEvents: 1,
    });
    await testDatabase.pool.query(
      `update execution_event_streams
       set last_ack_confirmed_sequence = null, claim_owner = null, claim_expires_at = null
       where execution_host_id = $1`,
      [hostId],
    );
    const replay = await consumeRuntimeEventStreamOnce({
      db: testDatabase.db,
      executionHostId: hostId,
      transport: {
        async *streamRuntimeEvents() {},
        async acknowledgeRuntimeEvents(input: { streamId: string; throughSequence: string }) {
          acknowledgements.push(input);
          return { streamId: input.streamId, acknowledgedThrough: input.throughSequence };
        },
      } as unknown as ExecutionHostTransport,
      owner: "test-consumer-b",
      maxEvents: 1,
    });
    const watermark = await testDatabase.pool.query(
      `select last_contiguous_sequence::text, last_ack_confirmed_sequence::text
       from execution_event_streams where execution_host_id = $1`,
      [hostId],
    );

    expect(consumed).toMatchObject({ received: 1, acknowledged: 2 });
    expect(replay).toMatchObject({ received: 0, acknowledged: 1 });
    expect(acknowledgements).toEqual([
      { streamId, throughSequence: "2" },
      { streamId, throughSequence: "3" },
      { streamId, throughSequence: "3" },
    ]);
    expect(watermark.rows[0]).toEqual({
      last_contiguous_sequence: "3",
      last_ack_confirmed_sequence: "3",
    });
  });

  it("isolates a poisoned projector cursor while an independent view advances", async () => {
    const lifecycle = await projectExecutionEvents({
      db: testDatabase.db,
      runId,
      projector: { consumerName: "test-lifecycle", project: async () => {} },
      owner: "projector-lifecycle",
    });
    const poisonEvent = event("4");
    await ingestRuntimeEvent({
      db: testDatabase.db,
      executionHostId: hostId,
      envelope: poisonEvent,
    });
    const poisoned = await projectExecutionEvents({
      db: testDatabase.db,
      runId,
      projector: {
        consumerName: "test-lifecycle",
        project: async () => {
          throw new ExecutionEventProjectionError("invalid lifecycle transition", true);
        },
      },
      owner: "projector-lifecycle",
    });
    const browser = await projectExecutionEvents({
      db: testDatabase.db,
      runId,
      projector: { consumerName: "test-browser", project: async () => {} },
      owner: "projector-browser",
    });
    const cursors = await testDatabase.pool.query(
      `select consumer_name, state, last_run_sequence::text, poison_event_id
       from execution_event_consumers where run_id = $1 order by consumer_name`,
      [runId],
    );

    expect(lifecycle).toMatchObject({ projected: 3, lastRunSequence: "2" });
    expect(poisoned).toMatchObject({ poisoned: true, lastRunSequence: "2" });
    expect(browser).toMatchObject({ projected: 4, lastRunSequence: "3" });
    expect(cursors.rows).toEqual([
      {
        consumer_name: "test-browser",
        state: "ready",
        last_run_sequence: "3",
        poison_event_id: null,
      },
      {
        consumer_name: "test-lifecycle",
        state: "poisoned",
        last_run_sequence: "2",
        poison_event_id: poisonEvent.eventId,
      },
    ]);
  });

  it("degrades a host rather than silently accepting a replacement stream", async () => {
    await expect(
      ingestRuntimeEvent({
        db: testDatabase.db,
        executionHostId: hostId,
        envelope: event("0", { streamId: randomUUID() }),
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    const host = await testDatabase.pool.query(
      "select readiness, readiness_reason from execution_hosts where id = $1",
      [hostId],
    );

    expect(host.rows[0]).toEqual({
      readiness: "unavailable",
      readiness_reason: "event_stream_identity_conflict",
    });
  });
});
