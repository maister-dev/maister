// ADR-167 amendment (2026-09-25), I1 + I3: a runtime-event batch is ONE
// PostgreSQL transaction whose per-row outcome equals the per-event path's on
// the same input, and a failure inside it is isolated to the envelope that
// caused it. Every case owns its host and stream: the per-event suite
// (`ingest.integration.test.ts`) shares one stream across its cases, so it
// cannot host a control that needs a known starting watermark.
import type { Db } from "@/lib/execution-host/db";

import { randomUUID } from "node:crypto";

import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as fullSchema from "@/lib/db/schema";
import {
  ingestRuntimeEvent,
  ingestRuntimeEventBatch,
} from "@/lib/execution-host/events/ingest";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

let testDatabase: StartedPostgresTestDb;
let projectId: string;

type Fixture = {
  hostId: string;
  hostKey: string;
  streamId: string;
  runIds: string[];
  assignmentIds: string[];
  releasedAssignmentId: string;
};

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "execution_event_ingest_batch_test",
  });
  projectId = randomUUID();
  await testDatabase.pool.query(
    `insert into projects (id, slug, name, repo_path, maister_yaml_path, task_key)
     values ($1, 'event-batch', 'Event batch', '/tmp/event-batch', '/tmp/event-batch/maister.yaml', 'EVT-BATCH')`,
    [projectId],
  );
  // Real refusals, not mocks: a payload PostgreSQL rejects mid-insert, and one
  // deadlock on the first attempt of a marked batch (a sequence is outside
  // every transaction, so the rollback does not re-arm it).
  await testDatabase.pool.query(`
    create sequence ingest_batch_deadlock_once;
    create function ingest_batch_refuse() returns trigger language plpgsql as $$
    begin
      if new.payload -> 'update' ->> 'sessionUpdate' = 'refused_by_postgres' then
        raise exception 'unsupported Unicode escape sequence' using errcode = '22P05';
      end if;
      -- Nested, not AND: SQL does not promise to short-circuit, and a
      -- nextval() spent on another row would disarm the fault.
      if new.payload -> 'update' ->> 'sessionUpdate' = 'deadlock_once' then
        if nextval('ingest_batch_deadlock_once') = 1 then
          raise exception 'deadlock detected' using errcode = '40P01';
        end if;
      end if;
      return new;
    end $$;
    create trigger ingest_batch_refuse before insert on execution_events
      for each row execute function ingest_batch_refuse();
  `);
}, 240_000);

afterAll(async () => {
  await testDatabase?.stop();
});

async function fixture(runCount: number): Promise<Fixture> {
  const hostId = randomUUID();
  const hostKey = `eh_${randomUUID().replace(/-/g, "")}`;
  const runIds = Array.from({ length: runCount }, () => randomUUID());
  const assignmentIds = runIds.map(() => randomUUID());
  const releasedAssignmentId = randomUUID();

  // At most one non-retired local host may exist, and each case needs its
  // own; ingest resolves a host by id and never reads retirement.
  await testDatabase.pool.query(
    `insert into execution_hosts (id, host_key, kind, display_name, transport, retired_at)
     values ($1, $2, 'local_direct', 'batch host', '{"kind":"local_direct"}', now())`,
    [hostId, hostKey],
  );
  for (const [index, runId] of runIds.entries()) {
    await testDatabase.pool.query(
      `insert into runs (id, project_id, run_kind, status, flow_version, flow_revision)
       values ($1, $2, 'scratch', 'Pending', 'scratch', 'manual')`,
      [runId, projectId],
    );
    await testDatabase.pool.query(
      `insert into execution_assignments
         (id, run_id, execution_host_id, epoch, state, placement_reason)
       values ($1, $2, $3, 2, 'active', 'launch')`,
      [assignmentIds[index], runId, hostId],
    );
  }
  await testDatabase.pool.query(
    `insert into execution_assignments
       (id, run_id, execution_host_id, epoch, state, placement_reason, ended_at, released_reason)
     values ($1, $2, $3, 1, 'released', 'launch', now(), 'test_stale_epoch')`,
    [releasedAssignmentId, runIds[0], hostId],
  );

  return {
    hostId,
    hostKey,
    streamId: randomUUID(),
    runIds,
    assignmentIds,
    releasedAssignmentId,
  };
}

function envelope(
  f: Fixture,
  sequence: number,
  run: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    envelopeVersion: 1,
    eventId: randomUUID(),
    hostKey: f.hostKey,
    hostBootId: "8d1f7c52-2d4f-4f31-9a57-3f6f6f2a9d01",
    streamId: f.streamId,
    sequence: String(sequence),
    runId: f.runIds[run],
    assignmentId: f.assignmentIds[run],
    assignmentEpoch: 2,
    hostSessionId: "4c2b9f1e-7a31-4d5b-8f0e-2b6d9c1a7e33",
    eventType: "session.update",
    occurredAt: "2026-09-25T00:00:00.000Z",
    payloadSchema: "maister.session.update.v1",
    payload: { update: { state: `working ${sequence}` } },
    ...overrides,
  };
}

/** The same host-order input for two independent hosts. */
function scenario(f: Fixture) {
  const held = envelope(f, 1, 2);
  const stale = envelope(f, 3, 0, {
    assignmentId: f.releasedAssignmentId,
    assignmentEpoch: 1,
  });

  return {
    before: [held],
    batch: [
      envelope(f, 0, 0), // fills the gap held open by run 2's sequence 1
      envelope(f, 2, 1),
      stale,
      { ...stale }, // the host replayed the same frame on one connection
      envelope(f, 4, 0),
      { ...held }, // a duplicate of the row pending before the batch
    ],
  };
}

function statementLog(): { db: Db; statements: string[] } {
  const statements: string[] = [];
  const db = drizzle(testDatabase.pool, {
    schema: fullSchema,
    logger: { logQuery: (query) => statements.push(query) },
  }) as unknown as Db;

  return { db, statements };
}

async function storedRows(f: Fixture) {
  const { rows } = await testDatabase.pool.query<{
    host_sequence: string;
    ingest_disposition: string;
    run_index: number;
    run_sequence: string | null;
  }>(
    `select e.host_sequence::text, e.ingest_disposition,
            array_position($2::text[], e.run_id) - 1 as run_index,
            e.run_sequence::text
       from execution_events e
       join execution_event_streams s on s.id = e.event_stream_id
      where s.stream_id = $1
      order by e.host_sequence`,
    [f.streamId, f.runIds],
  );

  return rows;
}

describe("runtime event batch ingest (ADR-167 amendment 2026-09-25)", () => {
  it("I1: commits a batch in one transaction with the per-event dispositions", async () => {
    const perEvent = await fixture(3);
    const batched = await fixture(3);
    const one = scenario(perEvent);
    const many = scenario(batched);

    for (const raw of one.before)
      await ingestRuntimeEvent({
        db: testDatabase.db,
        executionHostId: perEvent.hostId,
        envelope: raw,
      });
    for (const raw of many.before)
      await ingestRuntimeEvent({
        db: testDatabase.db,
        executionHostId: batched.hostId,
        envelope: raw,
      });
    const expected = [];

    for (const raw of one.batch)
      expected.push(
        (
          await ingestRuntimeEvent({
            db: testDatabase.db,
            executionHostId: perEvent.hostId,
            envelope: raw,
          })
        ).disposition,
      );
    const log = statementLog();
    const result = await ingestRuntimeEventBatch({
      db: log.db,
      executionHostId: batched.hostId,
      envelopes: many.batch,
    });
    const count = (pattern: RegExp) =>
      log.statements.filter((statement) => pattern.test(statement)).length;

    expect(expected).toEqual([
      "accepted",
      "accepted",
      "stale_epoch",
      "duplicate",
      "accepted",
      "duplicate",
    ]);
    expect(result.results.map((row) => row.disposition)).toEqual(expected);
    expect(result).toMatchObject({
      contiguousThrough: "4",
      acceptedCount: 4,
      staleEpochCount: 1,
      pendingGapCount: 0,
    });
    expect(new Set(result.promotedRunIds)).toEqual(new Set(batched.runIds));
    expect(count(/^begin$/i)).toBe(1);
    expect(count(/^commit$/i)).toBe(1);
    expect(count(/from "execution_event_streams".*for update/is)).toBe(1);
    // Runs are locked once, ascending, before any insert — including run 2,
    // which is only in the batch because the gap filler releases its row.
    const runLocks = log.statements
      .map((statement, index) => ({ statement, index }))
      .filter(({ statement }) =>
        /from "runs".*order by "runs"\."id" asc.*for update/is.test(statement),
      );
    const firstInsert = log.statements.findIndex((statement) =>
      /^insert into "execution_events"/i.test(statement),
    );

    expect(runLocks).toHaveLength(1);
    expect(runLocks[0]!.index).toBeLessThan(firstInsert);
    expect(count(/^insert into "execution_events"/i)).toBe(1);
    expect(count(/^update "execution_event_streams"/i)).toBe(1);
    expect(count(/^update "execution_hosts"/i)).toBe(1);
    // Same committed state as the per-event path, row for row.
    expect(await storedRows(batched)).toEqual(await storedRows(perEvent));
  });

  it("I3: isolates an unknown run and a refused payload while the healthy rows commit", async () => {
    const f = await fixture(1);
    const foreignRun = randomUUID();
    const refused = envelope(f, 2, 0, {
      payload: { update: { sessionUpdate: "refused_by_postgres" } },
    });
    const result = await ingestRuntimeEventBatch({
      db: testDatabase.db,
      executionHostId: f.hostId,
      envelopes: [
        envelope(f, 0, 0),
        envelope(f, 1, 0, { runId: foreignRun }),
        refused,
        envelope(f, 3, 0),
      ],
    });
    const skips = await testDatabase.pool.query<{
      host_sequence: string;
      reason: string;
    }>(
      `select k.host_sequence::text, k.reason from execution_event_skips k
         join execution_event_streams s on s.id = k.event_stream_id
        where s.stream_id = $1 order by k.host_sequence`,
      [f.streamId],
    );

    expect(result.results.map((row) => row.disposition)).toEqual([
      "accepted",
      "skipped_unknown_run",
      "skipped_unknown_run",
      "accepted",
    ]);
    expect(result.contiguousThrough).toBe("3");
    expect(skips.rows).toEqual([
      { host_sequence: "1", reason: "unknown_run" },
      { host_sequence: "2", reason: "payload_unstorable" },
    ]);
    expect(await storedRows(f)).toEqual([
      {
        host_sequence: "0",
        ingest_disposition: "accepted",
        run_index: 0,
        run_sequence: "0",
      },
      {
        host_sequence: "3",
        ingest_disposition: "accepted",
        run_index: 0,
        run_sequence: "1",
      },
    ]);
  });

  it("I3: retries a deadlocked batch in place once, with no duplicate effect", async () => {
    const f = await fixture(1);
    const warnings: string[] = [];
    const logger = {
      warn: (_fields: unknown, message: string) => warnings.push(message),
      info: () => {},
      debug: () => {},
    } as unknown as Parameters<typeof ingestRuntimeEventBatch>[0]["logger"];
    const result = await ingestRuntimeEventBatch({
      db: testDatabase.db,
      executionHostId: f.hostId,
      logger,
      envelopes: [
        envelope(f, 0, 0),
        envelope(f, 1, 0, {
          payload: { update: { sessionUpdate: "deadlock_once" } },
        }),
        envelope(f, 2, 0),
      ],
    });

    expect(warnings).toEqual(["runtime-event-batch-retried"]);
    expect(result.results.map((row) => row.disposition)).toEqual([
      "accepted",
      "accepted",
      "accepted",
    ]);
    expect(await storedRows(f)).toEqual(
      ["0", "1", "2"].map((sequence) => ({
        host_sequence: sequence,
        ingest_disposition: "accepted",
        run_index: 0,
        run_sequence: sequence,
      })),
    );
  });
});
