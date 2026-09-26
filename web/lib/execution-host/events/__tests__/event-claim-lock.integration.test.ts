import type { Db } from "@/lib/execution-host/db";
import type { ExecutionHostTransport } from "@/lib/execution-host/contracts";
import type { RuntimeEventConsumerSummary } from "@/lib/execution-host/events/consumer";

import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { INGEST_BATCH_WAIT_MS } from "@/lib/execution-host/events/batching";
import { ingestRuntimeEvent } from "@/lib/execution-host/events/ingest";
import {
  claimRuntimeEventStream,
  consumeRuntimeEventStreamOnce,
  startRuntimeEventConsumer,
  stopRuntimeEventConsumers,
} from "@/lib/execution-host/events/consumer";
import { mintAssignment } from "@/lib/execution-host/assignments";
import { projectRuntimeObject } from "@/lib/execution-host/events/runtime-object-projector";
import {
  executionEvents,
  executionEventStreams,
  executionRuntimeObjects,
} from "@/lib/db/schema";
import { createFakeExecutionHost } from "@/test-support/fake-execution-host";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

let testDatabase: StartedPostgresTestDb;
let db: Db;
const projectId = randomUUID();
const hostId = randomUUID();
const hostKey = `eh_${randomUUID().replaceAll("-", "")}`;
const streamId = randomUUID();

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "event_claim_lock",
  });
  db = testDatabase.db as unknown as Db;
  await testDatabase.pool.query(
    `INSERT INTO projects (id, slug, name, repo_path, maister_yaml_path, task_key)
     VALUES ($1, 'event-claim-lock', 'Event claim lock', '/tmp/event-claim-lock', '/tmp/event-claim-lock/maister.yaml', 'ECL')`,
    [projectId],
  );
  await testDatabase.pool.query(
    `INSERT INTO execution_hosts (id, host_key, kind, display_name, transport)
     VALUES ($1, $2, 'local_direct', 'event claim lock host', '{"kind":"local_direct"}')`,
    [hostId, hostKey],
  );
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

function event(
  sequence: string,
  fields: Record<string, unknown>,
): Record<string, unknown> {
  return {
    envelopeVersion: 1,
    eventId: randomUUID(),
    hostKey,
    hostBootId: randomUUID(),
    sequence,
    assignmentEpoch: 1,
    occurredAt: "2026-09-04T00:00:00.000Z",
    ...fields,
  };
}

describe("Event ingestion and assignment claim locks", () => {
  it("honours cancellation received while acquiring a stream claim and releases that claim", async () => {
    const targetStreamId = randomUUID();
    const streamRowId = randomUUID();
    const now = new Date("2026-09-09T00:00:00.000Z");
    const controller = new AbortController();
    let openedStreams = 0;
    const transport: ExecutionHostTransport = {
      ...createFakeExecutionHost().transport,
      async *streamRuntimeEvents() {
        openedStreams += 1;
      },
    };

    await db.insert(executionEventStreams).values({
      id: streamRowId,
      executionHostId: hostId,
      streamId: targetStreamId,
      state: "active",
    });
    const barrier = await testDatabase.pool.connect();
    let completion:
      | Promise<PromiseSettledResult<RuntimeEventConsumerSummary>[]>
      | undefined;
    let releasePromise: Promise<void> | undefined;
    const releaseBarrier = (): Promise<void> =>
      (releasePromise ??= barrier.query("COMMIT").then(() => undefined));

    await barrier.query("BEGIN");
    try {
      await barrier.query(
        "SELECT id FROM execution_event_streams WHERE id = $1 FOR UPDATE",
        [streamRowId],
      );
      const blocker = await barrier.query<{ pid: number }>(
        "SELECT pg_backend_pid() AS pid",
      );

      completion = Promise.allSettled([
        consumeRuntimeEventStreamOnce({
          db,
          executionHostId: hostId,
          transport,
          owner: "cancelled-consumer",
          signal: controller.signal,
          now: () => now,
        }),
      ]);
      await expect
        .poll(
          async () => {
            const waiting = await testDatabase.pool.query<{ count: number }>(
              "SELECT count(*)::int AS count FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))",
              [blocker.rows[0].pid],
            );

            return waiting.rows[0].count;
          },
          { timeout: 10_000, interval: 25 },
        )
        .toBe(1);
      controller.abort();
      await releaseBarrier();
      const result = await completion;
      const successor = await claimRuntimeEventStream({
        db,
        executionHostId: hostId,
        owner: "successor-consumer",
        now: new Date(now.getTime() + 1),
      });

      expect({ result, openedStreams, successor }).toMatchObject({
        result: [
          {
            status: "rejected",
            reason: {
              code: "EXECUTOR_UNAVAILABLE",
              details: { reason: "aborted" },
            },
          },
        ],
        openedStreams: 0,
        successor: { streamRowId, streamId: targetStreamId },
      });
    } finally {
      controller.abort();
      await releaseBarrier();
      await completion;
      barrier.release();
      await db
        .delete(executionEventStreams)
        .where(eq(executionEventStreams.id, streamRowId));
    }
  });

  it("releases a stopped consumer's stream claim so a successor claims immediately", async () => {
    const targetStreamId = randomUUID();
    const streamRowId = randomUUID();
    let openedStreams = 0;
    // The host closes the stream (a restart) at the moment the consumer is
    // stopped: the pass ends without an error, which is the path that used
    // to keep the lease.
    const transport: ExecutionHostTransport = {
      ...createFakeExecutionHost().transport,
      async *streamRuntimeEvents(opts) {
        openedStreams += 1;
        await new Promise<void>((resolve) => {
          if (opts?.signal?.aborted) return resolve();
          opts?.signal?.addEventListener("abort", () => resolve(), {
            once: true,
          });
        });
      },
    };

    await db.insert(executionEventStreams).values({
      id: streamRowId,
      executionHostId: hostId,
      streamId: targetStreamId,
      state: "active",
    });
    try {
      startRuntimeEventConsumer({ db, executionHostId: hostId, transport });
      await expect
        .poll(
          async () => {
            const [row] = await db
              .select({ owner: executionEventStreams.claimOwner })
              .from(executionEventStreams)
              .where(eq(executionEventStreams.id, streamRowId));

            return row?.owner ?? null;
          },
          { timeout: 10_000, interval: 25 },
        )
        .toMatch(/^web-event-consumer:/);
      await stopRuntimeEventConsumers();
      const successor = await claimRuntimeEventStream({
        db,
        executionHostId: hostId,
        owner: "successor-consumer",
        now: new Date(Date.now() + 1),
      });

      expect({ openedStreams, successor }).toMatchObject({
        openedStreams: 1,
        successor: { streamRowId, streamId: targetStreamId },
      });
    } finally {
      await stopRuntimeEventConsumers();
      await db
        .delete(executionEventStreams)
        .where(eq(executionEventStreams.id, streamRowId));
    }
  });

  it("renews a long pass's claim in every batch, while a killed holder's claim still lapses", async () => {
    // ADR-167 amendment 2026-09-25: a pass now stays open under load far
    // longer than the 30 s lease. Each event below lands 20 s of lease time
    // after the previous one, so without a renewal the claim would lapse
    // under the live pass and a competitor would take the ACK watermark.
    const targetStreamId = randomUUID();
    const streamRowId = randomUUID();
    let clock = new Date("2026-09-25T00:00:00.000Z").getTime();
    const now = () => new Date(clock);
    const competitors: unknown[] = [];
    const transport: ExecutionHostTransport = {
      ...createFakeExecutionHost().transport,
      async *streamRuntimeEvents() {
        for (let sequence = 0; sequence < 4; sequence += 1) {
          clock += 20_000;
          yield event(String(sequence), {
            streamId: targetStreamId,
            runId: randomUUID(),
            assignmentId: randomUUID(),
            hostSessionId: randomUUID(),
            eventType: "session.update",
            payloadSchema: "maister.session.update.v1",
            payload: { update: { state: `working ${sequence}` } },
          }) as never;
          // The batch is cut T after its first row; let it commit first.
          await delay(INGEST_BATCH_WAIT_MS + 250);
          competitors.push(
            await claimRuntimeEventStream({
              db,
              executionHostId: hostId,
              owner: "competitor-consumer",
              now: now(),
            }),
          );
        }
      },
    };

    await db.insert(executionEventStreams).values({
      id: streamRowId,
      executionHostId: hostId,
      streamId: targetStreamId,
      state: "active",
    });
    try {
      const summary = await consumeRuntimeEventStreamOnce({
        db,
        executionHostId: hostId,
        transport,
        owner: "long-pass-consumer",
        now,
      });

      expect(summary).toMatchObject({
        received: 4,
        batches: 4,
        reconnectRequired: false,
      });
      expect(competitors).toEqual([null, null, null, null]);
      // The holder is gone (the pass ended without releasing, as a killed
      // process would): a successor is refused inside the last lease...
      expect(
        await claimRuntimeEventStream({
          db,
          executionHostId: hostId,
          owner: "successor-consumer",
          now: new Date(clock + 1_000),
        }),
      ).toBeNull();
      // ...and claims once it lapses.
      expect(
        await claimRuntimeEventStream({
          db,
          executionHostId: hostId,
          owner: "successor-consumer",
          now: new Date(clock + 31_000),
        }),
      ).toMatchObject({ streamRowId, streamId: targetStreamId });
    } finally {
      await db
        .delete(executionEventStreams)
        .where(eq(executionEventStreams.id, streamRowId));
    }
  });

  it("concurrent object projection validates one committed catalogue row", async () => {
    const targetRunId = randomUUID();
    const targetAssignmentId = randomUUID();
    const targetCommandId = randomUUID();
    const targetSessionId = randomUUID();
    const objectId = `obj_${randomUUID().replaceAll("-", "")}`;
    const key = Math.floor(Math.random() * 2_000_000_000) + 1;
    const trigger = `object_projection_${randomUUID().replaceAll("-", "")}`;
    let projections: Promise<void>[] = [];
    let settled: Promise<PromiseSettledResult<void>[]> | undefined;

    await testDatabase.pool.query(
      `INSERT INTO runs (id, project_id, run_kind, status, flow_version, flow_revision)
       VALUES ($1, $2, 'scratch', 'Running', 'scratch', 'object-projection')`,
      [targetRunId, projectId],
    );
    await testDatabase.pool.query(
      `INSERT INTO execution_assignments (id, run_id, execution_host_id, epoch, state, placement_reason)
       VALUES ($1, $2, $3, 1, 'active', 'launch')`,
      [targetAssignmentId, targetRunId, hostId],
    );
    await testDatabase.pool.query(
      `INSERT INTO execution_commands
       (id, run_id, execution_assignment_id, execution_host_id, assignment_epoch,
        kind, payload, state, max_attempts)
       VALUES ($1, $2, $3, $4, 1, 'session.create', '{}', 'accepted', 3)`,
      [targetCommandId, targetRunId, targetAssignmentId, hostId],
    );
    const eventId = randomUUID();
    const payload = {
      objectId,
      kind: "raw_transcript",
      logicalName: "stdout-overflow.ndjson",
      mimeType: "application/x-ndjson",
      sha256: "a".repeat(64),
      sizeBytes: 2,
      generation: 1,
      retentionClass: "run",
      state: "available",
      expiresAt: null,
      stdoutSegment: {
        commandId: targetCommandId,
        firstLogByteOffset: 0,
        capturedBytes: 2,
        completeFrames: 1,
        trailingFrameBytes: 0,
      },
    };

    await ingestRuntimeEvent({
      db,
      executionHostId: hostId,
      envelope: event("0", {
        eventId,
        runId: targetRunId,
        assignmentId: targetAssignmentId,
        streamId,
        hostSessionId: targetSessionId,
        eventType: "runtime_object.available",
        payloadSchema: "maister.runtime-object.available.v1",
        payload,
      }),
    });
    const [storedEvent] = await db
      .select()
      .from(executionEvents)
      .where(eq(executionEvents.id, eventId));

    const barrier = await testDatabase.pool.connect();

    try {
      await barrier.query("SELECT pg_advisory_lock(260914, $1)", [key]);
      await testDatabase.pool.query(
        `CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id = '${objectId}' THEN PERFORM pg_advisory_xact_lock(260914, ${key}); END IF; RETURN NEW; END $$`,
      );
      await testDatabase.pool.query(
        `CREATE TRIGGER ${trigger} BEFORE INSERT ON execution_runtime_objects FOR EACH ROW EXECUTE FUNCTION ${trigger}()`,
      );
      projections = [0, 1].map(() =>
        db.transaction((tx) => projectRuntimeObject(tx, storedEvent)),
      );
      settled = Promise.allSettled(projections);
      await expect
        .poll(
          async () => {
            const rows = await testDatabase.pool.query<{ count: number }>(
              "SELECT count(*)::int AS count FROM pg_locks WHERE locktype = 'advisory' AND classid = 260914 AND objid = $1 AND NOT granted",
              [key],
            );

            return rows.rows[0].count;
          },
          { timeout: 10_000, interval: 25 },
        )
        .toBe(2);
      await barrier.query("SELECT pg_advisory_unlock_all()");
      expect(await settled).toEqual([
        { status: "fulfilled", value: undefined },
        { status: "fulfilled", value: undefined },
      ]);
      await expect(
        db.transaction((tx) =>
          projectRuntimeObject(tx, {
            ...storedEvent,
            payload: { ...payload, sha256: "b".repeat(64) },
          }),
        ),
      ).rejects.toMatchObject({ permanent: true });
      const rows = await db
        .select()
        .from(executionRuntimeObjects)
        .where(eq(executionRuntimeObjects.id, objectId));

      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        sha256: "a".repeat(64),
        state: "available",
        sourceEventId: eventId,
        generation: 1,
      });
    } finally {
      await barrier.query("SELECT pg_advisory_unlock_all()");
      await settled;
      barrier.release();
      await testDatabase.pool.query(
        `DROP TRIGGER IF EXISTS ${trigger} ON execution_runtime_objects`,
      );
      await testDatabase.pool.query(`DROP FUNCTION IF EXISTS ${trigger}()`);
    }
  });

  it("serializes event insertion with a resume claim before foreign-key lock upgrade", async () => {
    const targetRunId = randomUUID();
    const targetAssignmentId = randomUUID();
    const targetStreamId = streamId;
    const targetCommandId = randomUUID();
    const targetSessionId = randomUUID();
    const eventId = randomUUID();
    const key = Math.floor(Math.random() * 2_000_000_000) + 1;
    const trigger = `zz_ingest_claim_${randomUUID().replaceAll("-", "")}`;
    const applicationName = `claim-${randomUUID()}`;
    let ingestion: Promise<unknown> | undefined;
    let claim: Promise<unknown> | undefined;

    await testDatabase.pool.query(
      `insert into runs (id, project_id, run_kind, status, flow_version, flow_revision)
       values ($1, $2, 'scratch', 'NeedsInputIdle', 'scratch', 'lock-upgrade')`,
      [targetRunId, projectId],
    );
    await testDatabase.pool.query(
      `insert into execution_assignments
       (id, run_id, execution_host_id, epoch, state, placement_reason, ended_at, released_reason)
       values ($1, $2, $3, 1, 'released', 'launch', now(), 'checkpointed')`,
      [targetAssignmentId, targetRunId, hostId],
    );
    await testDatabase.pool.query(
      "UPDATE runs SET execution_assignment_id = $1 WHERE id = $2",
      [targetAssignmentId, targetRunId],
    );
    await testDatabase.pool.query(
      `INSERT INTO execution_commands
       (id, run_id, execution_assignment_id, execution_host_id, assignment_epoch,
        kind, target_session_id, payload, state, max_attempts)
       VALUES ($1, $2, $3, $4, 1, 'session.checkpoint', $5, '{}', 'accepted', 3)`,
      [
        targetCommandId,
        targetRunId,
        targetAssignmentId,
        hostId,
        targetSessionId,
      ],
    );
    const barrier = await testDatabase.pool.connect();

    try {
      await barrier.query("SELECT pg_advisory_lock(260913, $1)", [key]);
      // PostgreSQL fires AFTER triggers in name order. This barrier follows
      // its RI_ConstraintTrigger and therefore holds the real run FK lock.
      await testDatabase.pool.query(
        `CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id = '${eventId}' THEN PERFORM pg_advisory_xact_lock(260913, ${key}); END IF; RETURN NEW; END $$`,
      );
      await testDatabase.pool.query(
        `CREATE TRIGGER ${trigger} AFTER INSERT ON execution_events FOR EACH ROW EXECUTE FUNCTION ${trigger}()`,
      );
      const watermark = await testDatabase.pool.query<{
        next_sequence: string;
      }>(
        "SELECT (COALESCE(max(last_contiguous_sequence), -1) + 1)::text AS next_sequence FROM execution_event_streams WHERE execution_host_id = $1 AND stream_id = $2",
        [hostId, streamId],
      );

      ingestion = ingestRuntimeEvent({
        db: testDatabase.db,
        executionHostId: hostId,
        envelope: event(watermark.rows[0].next_sequence, {
          eventId,
          runId: targetRunId,
          assignmentId: targetAssignmentId,
          streamId: targetStreamId,
          hostSessionId: targetSessionId,
          eventType: "session.command",
          payloadSchema: "maister.session.command.v1",
          payload: {
            commandId: targetCommandId,
            kind: "session.checkpoint",
            phase: "completed",
            status: "succeeded",
            result: { sessionId: targetSessionId },
          },
        }),
      }).catch((error: unknown) => error);
      await expect
        .poll(
          async () => {
            const rows = await testDatabase.pool.query<{ count: number }>(
              "SELECT count(*)::int AS count FROM pg_locks WHERE locktype = 'advisory' AND classid = 260913 AND objid = $1 AND NOT granted",
              [key],
            );

            return rows.rows[0].count;
          },
          { timeout: 10_000, interval: 25 },
        )
        .toBe(1);
      claim = db
        .transaction(async (tx) => {
          await tx.execute(
            sql`SELECT set_config('application_name', ${applicationName}, true)`,
          );
          // The ordinary resume CAS precedes mintAssignment's run lock.
          await tx.execute(
            sql`UPDATE runs SET status = 'NeedsInput' WHERE id = ${targetRunId} AND status = 'NeedsInputIdle'`,
          );

          return mintAssignment(tx, {
            runId: targetRunId,
            hostId,
            reason: "resume",
          });
        })
        .catch((error: unknown) => error);
      await expect
        .poll(
          async () => {
            const rows = await testDatabase.pool.query<{ count: number }>(
              "SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name = $1 AND wait_event_type = 'Lock'",
              [applicationName],
            );

            return rows.rows[0].count;
          },
          { timeout: 10_000, interval: 25 },
        )
        .toBe(1);
      await barrier.query("SELECT pg_advisory_unlock_all()");
      const [ingested, assigned] = await Promise.all([ingestion, claim]);

      expect(ingested).toMatchObject({
        disposition: "accepted",
        acceptedCount: 1,
      });
      expect(assigned).toMatchObject({
        runId: targetRunId,
        epoch: 2,
        state: "active",
      });
      const rows = await testDatabase.pool.query<{ status: string }>(
        "SELECT status FROM runs WHERE id = $1",
        [targetRunId],
      );

      expect(rows.rows[0].status).toBe("NeedsInput");
    } finally {
      await barrier.query("SELECT pg_advisory_unlock_all()");
      await Promise.allSettled([ingestion, claim]);
      barrier.release();
      await testDatabase.pool.query(
        `DROP TRIGGER IF EXISTS ${trigger} ON execution_events`,
      );
      await testDatabase.pool.query(`DROP FUNCTION IF EXISTS ${trigger}()`);
    }
  });
});
