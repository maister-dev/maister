import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ingestRuntimeEvent } from "@/lib/execution-host/events/ingest";
import { consumeRuntimeEventStreamOnce } from "@/lib/execution-host/events/consumer";
import {
  ExecutionEventProjectionError,
  projectExecutionEvents,
} from "@/lib/execution-host/events/projector";
import { projectCanonicalPromptCommands } from "@/lib/execution-host/events/prompt-projector";
import { projectCanonicalSessionLifecycle } from "@/lib/execution-host/events/lifecycle-projector";
import { projectCanonicalRuntimeObjects } from "@/lib/execution-host/events/runtime-object-projector";
import { streamCanonicalSessionEvents } from "@/lib/execution-host/events/session-stream";
import { appendManagerRunStreamEvent } from "@/lib/runs/run-stream-event";
import type { ExecutionHostTransport } from "@/lib/execution-host/contracts";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

let testDatabase: StartedPostgresTestDb;
let projectId: string;
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
  projectId = randomUUID();
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
  it("replays a canonical session exclusively from manager-owned event rows", async () => {
    const canonicalRunId = randomUUID();
    const canonicalHostId = randomUUID();
    const canonicalAssignmentId = randomUUID();
    const canonicalHostKey = `eh_${randomUUID().replace(/-/g, "")}`;
    const canonicalStreamId = randomUUID();
    const hostSessionId = randomUUID();
    await testDatabase.pool.query(
      `insert into runs
        (id, project_id, run_kind, status, flow_version, flow_revision, execution_data_plane_mode)
       values ($1, $2, 'scratch', 'Pending', 'scratch', 'canonical-stream', 'canonical_events_v1')`,
      [canonicalRunId, projectId],
    );
    await testDatabase.pool.query(
      `insert into execution_hosts (id, host_key, kind, display_name, transport, retired_at)
       values ($1, $2, 'local_direct', 'canonical stream host', '{"kind":"local_direct"}', now())`,
      [canonicalHostId, canonicalHostKey],
    );
    await testDatabase.pool.query(
      `insert into execution_assignments
        (id, run_id, execution_host_id, epoch, state, placement_reason)
       values ($1, $2, $3, 1, 'active', 'launch')`,
      [canonicalAssignmentId, canonicalRunId, canonicalHostId],
    );
    const envelopes = [
      {
        envelopeVersion: 1 as const,
        eventId: randomUUID(),
        hostKey: canonicalHostKey,
        hostBootId: randomUUID(),
        streamId: canonicalStreamId,
        sequence: "0",
        runId: canonicalRunId,
        assignmentId: canonicalAssignmentId,
        assignmentEpoch: 1,
        hostSessionId,
        eventType: "session.update" as const,
        occurredAt: "2026-09-04T00:00:00.000Z",
        payloadSchema: "maister.session.update.v1" as const,
        payload: {
          sourceMonotonicId: 12,
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "durable" } },
        },
      },
      {
        envelopeVersion: 1 as const,
        eventId: randomUUID(),
        hostKey: canonicalHostKey,
        hostBootId: randomUUID(),
        streamId: canonicalStreamId,
        sequence: "1",
        runId: canonicalRunId,
        assignmentId: canonicalAssignmentId,
        assignmentEpoch: 1,
        hostSessionId,
        eventType: "session.exited" as const,
        occurredAt: "2026-09-04T00:00:01.000Z",
        payloadSchema: "maister.session.exited.v1" as const,
        payload: { sourceMonotonicId: 13, exitCode: 0, reason: "intentional" },
      },
    ];
    for (const envelope of envelopes) {
      await ingestRuntimeEvent({
        db: testDatabase.db,
        executionHostId: canonicalHostId,
        envelope,
      });
    }

    const replayed = [];
    for await (const event of streamCanonicalSessionEvents({
      db: testDatabase.db,
      runId: canonicalRunId,
      hostSessionId,
    })) {
      replayed.push(event);
    }

    expect(replayed).toEqual([
      expect.objectContaining({
        type: "session.update",
        sessionId: hostSessionId,
        monotonicId: 0,
      }),
      expect.objectContaining({
        type: "session.exited",
        sessionId: hostSessionId,
        monotonicId: 1,
        reason: "intentional",
      }),
    ]);
  });

  it("allocates one canonical sequence across concurrent host and manager events without a runtime file", async () => {
    const canonicalRunId = randomUUID();
    const canonicalHostId = randomUUID();
    const canonicalAssignmentId = randomUUID();
    const canonicalHostKey = `eh_${randomUUID().replace(/-/g, "")}`;
    const canonicalStreamId = randomUUID();
    await testDatabase.pool.query(
      `insert into runs
        (id, project_id, run_kind, status, flow_version, flow_revision, execution_data_plane_mode)
       values ($1, $2, 'scratch', 'Pending', 'scratch', 'canonical', 'canonical_events_v1')`,
      [canonicalRunId, projectId],
    );
    await testDatabase.pool.query(
      `insert into execution_hosts
        (id, host_key, kind, display_name, transport, retired_at)
       values ($1, $2, 'local_direct', 'retired canonical fixture host', '{"kind":"local_direct"}', now())`,
      [canonicalHostId, canonicalHostKey],
    );
    await testDatabase.pool.query(
      `insert into execution_assignments
        (id, run_id, execution_host_id, epoch, state, placement_reason)
       values ($1, $2, $3, 1, 'active', 'launch')`,
      [canonicalAssignmentId, canonicalRunId, canonicalHostId],
    );

    const [manager, host] = await Promise.all([
      appendManagerRunStreamEvent(testDatabase.db, {
        runId: canonicalRunId,
        sourceKey: "needs-input:review:human",
        event: {
          type: "run.needs_input",
          data: { nodeId: "review", reason: "human" },
        },
      }),
      ingestRuntimeEvent({
        db: testDatabase.db,
        executionHostId: canonicalHostId,
        envelope: {
          envelopeVersion: 1,
          eventId: randomUUID(),
          hostKey: canonicalHostKey,
          hostBootId: randomUUID(),
          streamId: canonicalStreamId,
          sequence: "0",
          runId: canonicalRunId,
          assignmentId: canonicalAssignmentId,
          assignmentEpoch: 1,
          hostSessionId: randomUUID(),
          eventType: "session.update",
          occurredAt: "2026-09-04T00:00:00.000Z",
          payloadSchema: "maister.session.update.v1",
          payload: { update: { state: "working" } },
        },
      }),
    ]);
    const replay = await appendManagerRunStreamEvent(testDatabase.db, {
      runId: canonicalRunId,
      sourceKey: "needs-input:review:human",
      event: {
        type: "run.needs_input",
        data: { nodeId: "review", reason: "human" },
      },
    });
    const rows = await testDatabase.pool.query(
      `select source, source_key, run_sequence::text, event_type, payload
       from execution_events where run_id = $1 order by run_sequence`,
      [canonicalRunId],
    );

    expect(manager).toMatchObject({ mode: "canonical_events_v1" });
    expect(host).toMatchObject({ disposition: "accepted" });
    expect(replay).toEqual(manager);
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows.map((row) => row.run_sequence)).toEqual(["0", "1"]);
    expect(rows.rows.filter((row) => row.source === "manager")).toEqual([
      expect.objectContaining({
        source_key: "needs-input:review:human",
        event_type: "run.needs_input",
        payload: { nodeId: "review", reason: "human" },
      }),
    ]);
  });

  it("rejects unsafe manager event payloads before allocating canonical history", async () => {
    const canonicalRunId = randomUUID();
    await testDatabase.pool.query(
      `insert into runs
        (id, project_id, run_kind, status, flow_version, flow_revision, execution_data_plane_mode)
       values ($1, $2, 'scratch', 'Pending', 'scratch', 'canonical', 'canonical_events_v1')`,
      [canonicalRunId, projectId],
    );

    await expect(
      appendManagerRunStreamEvent(testDatabase.db, {
        runId: canonicalRunId,
        sourceKey: "unsafe",
        event: { type: "run.needs_input", data: { token: "not-safe" } },
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION" });
    const rows = await testDatabase.pool.query(
      "select count(*)::int as count from execution_events where run_id = $1",
      [canonicalRunId],
    );
    expect(rows.rows[0]?.count).toBe(0);
  });

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
       from execution_event_consumers
       where run_id = $1 and consumer_name like 'test-%'
       order by consumer_name`,
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

  it("projects a canonical prompt terminal event exactly once and rejects a stale epoch from mutating it", async () => {
    const promptRunId = randomUUID();
    const promptAssignmentId = randomUUID();
    const commandId = randomUUID();
    await testDatabase.pool.query(
      `insert into runs
         (id, project_id, run_kind, status, execution_data_plane_mode, flow_version, flow_revision)
       values ($1, $2, 'scratch', 'Pending', 'canonical_events_v1', 'scratch', 'manual')`,
      [promptRunId, projectId],
    );
    await testDatabase.pool.query(
      `insert into execution_assignments
         (id, run_id, execution_host_id, epoch, state, placement_reason)
       values ($1, $2, $3, 1, 'active', 'launch')`,
      [promptAssignmentId, promptRunId, hostId],
    );
    await testDatabase.pool.query(
      `insert into execution_commands
         (id, run_id, execution_assignment_id, execution_host_id, assignment_epoch, kind, payload, state, max_attempts)
       values ($1, $2, $3, $4, 1, 'session.prompt', '{}', 'delivering', 3)`,
      [commandId, promptRunId, promptAssignmentId, hostId],
    );
    const terminal = event("5", {
      eventType: "session.command",
      runId: promptRunId,
      assignmentId: promptAssignmentId,
      payloadSchema: "maister.session.command.v1",
      payload: {
        commandId,
        kind: "session.prompt",
        phase: "completed",
        status: "succeeded",
        result: { stopReason: "end_turn", meta: null },
      },
    });
    await ingestRuntimeEvent({
      db: testDatabase.db,
      executionHostId: hostId,
      envelope: terminal,
    });
    const projected = await projectCanonicalPromptCommands({
      db: testDatabase.db,
      runId: promptRunId,
    });
    const replayed = await projectCanonicalPromptCommands({
      db: testDatabase.db,
      runId: promptRunId,
    });
    const row = await testDatabase.pool.query(
      "select state, result from execution_commands where id = $1",
      [commandId],
    );

    expect(projected).toMatchObject({ projected: 1 });
    expect(replayed).toMatchObject({ projected: 0 });
    expect(row.rows[0]).toEqual({
      state: "succeeded",
      result: { stopReason: "end_turn", meta: null },
    });

    const stale = event("6", {
      assignmentId: staleAssignmentId,
      assignmentEpoch: 2,
      runId: promptRunId,
      eventType: "session.command",
      payloadSchema: "maister.session.command.v1",
      payload: {
        commandId,
        kind: "session.prompt",
        phase: "completed",
        status: "failed",
        error: { code: "PRECONDITION", message: "stale" },
      },
    });
    await ingestRuntimeEvent({
      db: testDatabase.db,
      executionHostId: hostId,
      envelope: stale,
    });
    await projectCanonicalPromptCommands({
      db: testDatabase.db,
      runId: promptRunId,
    });
    const afterStale = await testDatabase.pool.query(
      "select state, result from execution_commands where id = $1",
      [commandId],
    );
    expect(afterStale.rows[0]).toEqual(row.rows[0]);

    const hostSessionId = randomUUID();
    await ingestRuntimeEvent({
      db: testDatabase.db,
      executionHostId: hostId,
      envelope: event("7", {
        runId: promptRunId,
        assignmentId: promptAssignmentId,
        hostSessionId,
        eventType: "session.created",
        payloadSchema: "maister.session.created.v1",
        payload: {
          sessionName: "default",
          adapter: "claude",
          acpSessionId: "acp-canonical",
        },
      }),
    });
    await projectCanonicalSessionLifecycle({
      db: testDatabase.db,
      runId: promptRunId,
    });
    const activeIncarnation = await testDatabase.pool.query(
      `select state, host_session_id, acp_session_id
       from run_session_incarnations where run_id = $1`,
      [promptRunId],
    );
    expect(activeIncarnation.rows).toEqual([
      {
        state: "active",
        host_session_id: hostSessionId,
        acp_session_id: "acp-canonical",
      },
    ]);

    await ingestRuntimeEvent({
      db: testDatabase.db,
      executionHostId: hostId,
      envelope: event("8", {
        runId: promptRunId,
        assignmentId: promptAssignmentId,
        hostSessionId,
        eventType: "session.exited",
        payloadSchema: "maister.session.exited.v1",
        payload: { exitCode: 0, reason: "intentional" },
      }),
    });
    await projectCanonicalSessionLifecycle({
      db: testDatabase.db,
      runId: promptRunId,
    });
    const exitedIncarnation = await testDatabase.pool.query(
      "select state, ended_at is not null as ended from run_session_incarnations where run_id = $1",
      [promptRunId],
    );
    expect(exitedIncarnation.rows).toEqual([{ state: "exited", ended: true }]);
  });

  it("projects host-owned runtime object metadata once without reading a runtime path", async () => {
    const objectRunId = randomUUID();
    const objectAssignmentId = randomUUID();
    const objectId = randomUUID();
    await testDatabase.pool.query(
      `insert into runs
         (id, project_id, run_kind, status, execution_data_plane_mode, flow_version, flow_revision)
       values ($1, $2, 'scratch', 'Pending', 'canonical_events_v1', 'scratch', 'manual')`,
      [objectRunId, projectId],
    );
    await testDatabase.pool.query(
      `insert into execution_assignments
         (id, run_id, execution_host_id, epoch, state, placement_reason)
       values ($1, $2, $3, 1, 'active', 'launch')`,
      [objectAssignmentId, objectRunId, hostId],
    );
    await ingestRuntimeEvent({
      db: testDatabase.db,
      executionHostId: hostId,
      envelope: event("9", {
        runId: objectRunId,
        assignmentId: objectAssignmentId,
        hostSessionId: null,
        eventType: "runtime_object.available",
        payloadSchema: "maister.runtime-object.available.v1",
        payload: {
          objectId,
          kind: "evidence",
          logicalName: "verification.json",
          mimeType: "application/json",
          sizeBytes: 11,
          sha256: "a".repeat(64),
          generation: 1,
          retentionClass: "run",
          state: "available",
          expiresAt: null,
        },
      }),
    });
    const first = await projectCanonicalRuntimeObjects({
      db: testDatabase.db,
      runId: objectRunId,
    });
    const replay = await projectCanonicalRuntimeObjects({
      db: testDatabase.db,
      runId: objectRunId,
    });
    const rows = await testDatabase.pool.query(
      `select id, logical_name, mime_type, size_bytes::text, sha256, state
       from execution_runtime_objects where id = $1`,
      [objectId],
    );

    expect(first).toMatchObject({ projected: 1 });
    expect(replay).toMatchObject({ projected: 0 });
    expect(rows.rows).toEqual([
      {
        id: objectId,
        logical_name: "verification.json",
        mime_type: "application/json",
        size_bytes: "11",
        sha256: "a".repeat(64),
        state: "available",
      },
    ]);

    await ingestRuntimeEvent({
      db: testDatabase.db,
      executionHostId: hostId,
      envelope: event("10", {
        runId: objectRunId,
        assignmentId: objectAssignmentId,
        hostSessionId: null,
        eventType: "runtime_object.available",
        payloadSchema: "maister.runtime-object.available.v1",
        payload: {
          objectId,
          kind: "evidence",
          logicalName: "verification.json",
          mimeType: "application/json",
          sizeBytes: 12,
          sha256: "b".repeat(64),
          generation: 1,
          retentionClass: "run",
          state: "available",
          expiresAt: null,
        },
      }),
    });
    const conflicting = await projectCanonicalRuntimeObjects({
      db: testDatabase.db,
      runId: objectRunId,
    });
    expect(conflicting).toMatchObject({ projected: 0, poisoned: true });
    const poison = await testDatabase.pool.query(
      `select state, last_error->>'message' as message
       from execution_event_consumers
       where consumer_name = 'canonical-runtime-object-v1' and run_id = $1`,
      [objectRunId],
    );
    expect(poison.rows).toEqual([
      {
        state: "poisoned",
        message:
          "runtime object available event conflicts with immutable metadata",
      },
    ]);
    const preserved = await testDatabase.pool.query(
      `select size_bytes::text, sha256 from execution_runtime_objects where id = $1`,
      [objectId],
    );
    expect(preserved.rows).toEqual([
      { size_bytes: "11", sha256: "a".repeat(64) },
    ]);
  });

  it("rejects duplicate event IDs whose immutable envelope spine changed", async () => {
    const baseline = event("11");
    await ingestRuntimeEvent({
      db: testDatabase.db,
      executionHostId: hostId,
      envelope: baseline,
    });
    const mutations: ReadonlyArray<{
      label: string;
      values: Record<string, unknown>;
    }> = [
      { label: "host boot", values: { hostBootId: randomUUID() } },
      {
        label: "assignment",
        values: { assignmentId: staleAssignmentId, assignmentEpoch: 2 },
      },
      { label: "assignment epoch", values: { assignmentEpoch: 2 } },
      { label: "host session", values: { hostSessionId: randomUUID() } },
      {
        label: "event type and payload schema",
        values: {
          eventType: "session.line",
          payloadSchema: "maister.session.line.v1",
        },
      },
      {
        label: "occurrence time",
        values: { occurredAt: "2026-09-04T00:00:01.000Z" },
      },
    ];

    for (const mutation of mutations) {
      await expect(
        ingestRuntimeEvent({
          db: testDatabase.db,
          executionHostId: hostId,
          envelope: { ...baseline, ...mutation.values },
        }),
        mutation.label,
      ).rejects.toMatchObject({
        code: "CONFLICT",
        details: { reason: "event_identity_conflict" },
      });
    }

    const stored = await testDatabase.pool.query(
      `select count(*)::int as count
       from execution_events where id = $1`,
      [baseline.eventId],
    );
    const watermark = await testDatabase.pool.query(
      `select last_contiguous_sequence::text as sequence
       from execution_event_streams
       where execution_host_id = $1 and stream_id = $2`,
      [hostId, streamId],
    );
    expect(stored.rows).toEqual([{ count: 1 }]);
    expect(watermark.rows).toEqual([{ sequence: "11" }]);
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
