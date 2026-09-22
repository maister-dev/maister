import type { PlatformStatus } from "@/types/platform-status";

import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  collectExecutionEventLag,
  executionConsumerLagQuery,
} from "@/lib/execution-host/events/lag-read-model";
import {
  seedLocalHost,
  seedProject,
  seedRun,
} from "@/test-support/execution-host-seed";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const NOW = new Date("2026-09-22T12:00:00.000Z");
const BOOT_ID = "e686cced-907b-4db5-82aa-1c836f866a73";
const STREAM_ID = "6cc44c0d-0a31-4cd7-a3c0-1b1d7e061503";
const STREAM_ROW_ID = "83456b45-e8d7-41cc-be4f-5eaad1d1ac85";

describe("execution event lag read model", () => {
  let database: StartedPostgresTestDb;
  let health: PlatformStatus;
  let runIds: string[];

  beforeAll(async () => {
    database = await startMainPostgresTestDb({
      databaseName: "execution_event_lag_read_model",
    });
    const projectId = await seedProject(database.db);
    const host = await seedLocalHost(database.db, { bootId: BOOT_ID });

    await database.db.execute(sql`
      INSERT INTO execution_event_streams (
        id, execution_host_id, stream_id, state,
        last_received_sequence, last_contiguous_sequence,
        last_ack_confirmed_sequence, last_boot_id, last_seen_at
      ) VALUES (
        ${STREAM_ROW_ID}, ${host.id}, ${STREAM_ID}, 'active',
        10, 8, 7, ${BOOT_ID}, ${new Date(NOW.getTime() - 1_000)}
      )
    `);

    runIds = [];
    const acceptedEventIds: string[] = [];

    for (let index = 0; index < 25; index += 1) {
      const runId = await seedRun(database.db, {
        projectId,
        status: index % 2 === 0 ? "Running" : "NeedsInputIdle",
      });
      const eventId = randomUUID();
      const horizon = 100 + index;
      const cursor = 100 - index;

      runIds.push(runId);
      acceptedEventIds.push(eventId);
      if (index < 22) {
        await database.db.execute(sql`
          INSERT INTO execution_assignments (
            id, run_id, execution_host_id, epoch, state, placement_reason
          ) VALUES (
            ${randomUUID()}, ${runId}, ${host.id}, 1, 'active', 'launch'
          )
        `);
      }
      await database.db.execute(sql`
        INSERT INTO execution_events (
          id, source, source_key, run_id, event_type, payload_schema,
          occurred_at, received_at, run_sequence, ingest_disposition
        ) VALUES (
          ${eventId}, 'manager', ${`lag-${index}`}, ${runId},
          'session.update', 'maister.test.v1', ${NOW}, ${NOW},
          ${BigInt(horizon)}, 'accepted'
        )
      `);
      if (index === 24) {
        await database.db.execute(sql`
          INSERT INTO execution_events (
            id, source, run_id, execution_host_id, event_stream_id,
            host_sequence, host_boot_id, envelope_version,
            event_type, payload_schema, occurred_at, received_at,
            run_sequence, ingest_disposition
          ) VALUES (
            ${randomUUID()}, 'host', ${runId}, ${host.id}, ${STREAM_ROW_ID},
            1124, ${BOOT_ID}, 1,
            'session.update', 'maister.test.v1', ${NOW}, ${NOW},
            NULL, 'quarantined'
          )
        `);
      }
      const poisoned = index < 21;

      await database.db.execute(sql`
        INSERT INTO execution_event_consumers (
          consumer_name, run_id, last_run_sequence, state, next_retry_at,
          poison_event_id, last_error, last_served_at
        ) VALUES (
          'run_projection_v1', ${runId}, ${BigInt(cursor)},
          ${poisoned ? "poisoned" : "ready"},
          ${poisoned ? new Date(NOW.getTime() + 60_000) : null},
          ${poisoned ? eventId : null},
          ${
            poisoned
              ? JSON.stringify({
                  reason: "fixture_poison",
                  eventId,
                  errorGeneration: randomUUID(),
                })
              : null
          }::jsonb,
          ${new Date(NOW.getTime() - index * 1_000)}
        )
      `);
    }

    await database.db.execute(sql`
      INSERT INTO node_attempts (
        id, run_id, node_id, node_type, attempt, status, error_code, started_at
      ) VALUES (
        ${randomUUID()}, ${runIds[24]}, 'lag-node', 'ai_coding', 1,
        'Failed', 'E_LAG', ${new Date(NOW.getTime() - 500)}
      )
    `);

    const terminalRunId = await seedRun(database.db, {
      projectId,
      status: "Done",
    });
    const terminalEventId = randomUUID();

    await database.db.execute(sql`
      INSERT INTO execution_events (
        id, source, source_key, run_id, event_type, payload_schema,
        occurred_at, received_at, run_sequence, ingest_disposition
      ) VALUES (
        ${terminalEventId}, 'manager', 'terminal-poison', ${terminalRunId},
        'session.update', 'maister.test.v1', ${NOW}, ${NOW}, 0, 'accepted'
      )
    `);
    await database.db.execute(sql`
      INSERT INTO execution_event_consumers (
        consumer_name, run_id, last_run_sequence, state, poison_event_id,
        last_error, last_served_at
      ) VALUES (
        'run_projection_v1', ${terminalRunId}, NULL, 'poisoned',
        ${terminalEventId},
        ${JSON.stringify({
          reason: "terminal_fixture_poison",
          eventId: terminalEventId,
          errorGeneration: randomUUID(),
        })}::jsonb,
        ${NOW}
      )
    `);
    await database.pool.query(
      `INSERT INTO execution_events (
         id, source, source_key, run_id, event_type, payload_schema,
         occurred_at, received_at, run_sequence, ingest_disposition
       )
       SELECT
         'perf-event-' || LPAD(sequence::text, 6, '0'),
         'manager',
         'perf-source-' || sequence::text,
         $1,
         'session.update',
         'maister.test.v1',
         $2,
         $2,
         sequence,
         'accepted'
       FROM generate_series(1, 50000) AS sequence`,
      [terminalRunId, NOW],
    );

    const assignment = await database.pool.query<{ id: string }>(
      "SELECT id FROM execution_assignments WHERE run_id = $1",
      [runIds[0]],
    );

    for (const [index, state] of [
      "queued",
      "delivering",
      "accepted",
      "accepted",
    ].entries()) {
      await database.db.execute(sql`
        INSERT INTO execution_commands (
          id, run_id, execution_assignment_id, execution_host_id,
          assignment_epoch, kind, state, max_attempts, accepted_at, created_at
        ) VALUES (
          ${randomUUID()}, ${runIds[0]}, ${assignment.rows[0]!.id}, ${host.id},
          1, 'session.create', ${state}, 3,
          ${
            state === "accepted" && index === 2
              ? new Date(NOW.getTime() - 60_000)
              : null
          },
          ${new Date(NOW.getTime() - index * 1_000)}
        )
      `);
    }

    health = {
      kind: "ready",
      health: {
        status: "ready",
        host: {
          hostKey: host.hostKey,
          bootId: BOOT_ID,
          protocolVersion: 1,
        },
        version: "test",
        uptimeMs: 1_000,
        checkedAt: NOW.toISOString(),
        sessions: { live: 1, exited: 0, crashed: 0 },
        stream: {
          streamId: STREAM_ID,
          headSequence: "15",
          unacknowledgedCount: 4,
          retainedCount: 8,
          pressured: false,
          oldestUnacknowledgedAgeMs: 3_000,
        },
      },
    };
  }, 300_000);

  afterAll(async () => {
    await database?.stop();
  });

  it("collects exact bigint lag, accepted-only horizons and bounded top consumers", async () => {
    const startedAt = performance.now();
    const model = await collectExecutionEventLag({
      db: database.db,
      health,
      now: NOW,
    });
    const durationMs = performance.now() - startedAt;

    expect(durationMs).toBeLessThan(2_000);

    expect(model.streams).toHaveLength(1);
    expect(model.streams[0]).toMatchObject({
      streamId: STREAM_ID,
      streamState: "active",
      hostTelemetryStatus: "available",
      lag: {
        hostToManager: "5",
        contiguityGap: "2",
        ackConfirmation: "1",
        diagnostics: [],
      },
    });
    expect(model.consumers).toMatchObject({
      eligiblePopulation: 25,
      totalConsumers: 25,
      displayed: 20,
      truncated: 5,
      maximumBacklog: "48",
    });
    expect(model.consumers.top.map((row) => row.backlog)).toEqual(
      Array.from({ length: 20 }, (_, index) => String(48 - index * 2)),
    );
    expect(model.consumers.top[0]).toMatchObject({
      runId: runIds[24],
      runHorizonSequence: "124",
      lastRunSequence: "76",
      executionHostId: null,
      latestNodeErrorCode: "E_LAG",
    });
    expect(model.consumers.byHost).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          executionHostId: null,
          consumerCount: 3,
          maximumBacklog: "48",
        }),
        expect.objectContaining({
          consumerCount: 22,
          maximumBacklog: "42",
        }),
      ]),
    );
    expect(model.commands).toMatchObject({
      total: 4,
      queued: 1,
      delivering: 1,
      accepted: 2,
      acceptedWithoutTimestamp: 1,
      oldestAcceptedAgeMs: 60_000,
    });
  });

  it("paginates poison independently and keeps the exact total", async () => {
    const first = await collectExecutionEventLag({
      db: database.db,
      health,
      now: NOW,
    });

    expect(first.poison).toMatchObject({
      total: 22,
      displayed: 20,
    });
    expect(first.poison.rows[0]?.errorEventId).toBe(
      first.poison.rows[0]?.poisonEventId,
    );
    expect(first.poison.nextAfter).not.toBeNull();

    const second = await collectExecutionEventLag({
      db: database.db,
      health,
      now: NOW,
      poisonAfter: first.poison.nextAfter!,
    });

    expect(second.poison).toMatchObject({
      total: 22,
      displayed: 2,
      nextAfter: null,
    });
    expect(
      new Set([
        ...first.poison.rows.map((row) => row.runId),
        ...second.poison.rows.map((row) => row.runId),
      ]).size,
    ).toBe(22);
  });

  it("uses the run-sequence index for bounded horizon reads", async () => {
    await database.pool.query("ANALYZE execution_events");
    const explained = await database.db.execute(
      sql`EXPLAIN (ANALYZE, BUFFERS) ${executionConsumerLagQuery()}`,
    );
    const plan = explained.rows
      .map((row) => String(row["QUERY PLAN"]))
      .join("\n");

    expect(plan).toMatch(/execution_events_run_sequence_(?:idx|uq)/);
  });
});
