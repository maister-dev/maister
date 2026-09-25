// ADR-167 amendment (2026-09-25), I2: the contiguity walk reads pending rows in
// bounded pages. 10 000 rows wait behind a gap — with skip-ledger holes inside
// them and a run that only appears after the first page — and one gap filler
// releases them all: promotion completes, no read returns more than one page,
// and the statement count grows with pages, not rows.
import type { Db } from "@/lib/execution-host/db";

import { randomUUID } from "node:crypto";

import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as fullSchema from "@/lib/db/schema";
import {
  ingestRuntimeEventBatch,
  PROMOTE_READ_ROWS,
} from "@/lib/execution-host/events/ingest";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const PENDING = 10_000;
const LATE_RUN_FROM = 3 * PROMOTE_READ_ROWS;
const FOREIGN_SEQUENCES = new Set([700, 1_501, 5_000, 9_999]);

let testDatabase: StartedPostgresTestDb;
let hostId: string;
let hostKey: string;
let streamId: string;
let earlyRun: string;
let lateRun: string;
const assignments = new Map<string, string>();

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "execution_event_ingest_walk_test",
  });
  const projectId = randomUUID();

  hostId = randomUUID();
  hostKey = `eh_${randomUUID().replace(/-/g, "")}`;
  streamId = randomUUID();
  earlyRun = randomUUID();
  lateRun = randomUUID();
  await testDatabase.pool.query(
    `insert into projects (id, slug, name, repo_path, maister_yaml_path, task_key)
     values ($1, 'event-walk', 'Event walk', '/tmp/event-walk', '/tmp/event-walk/maister.yaml', 'EVT-WALK')`,
    [projectId],
  );
  await testDatabase.pool.query(
    `insert into execution_hosts (id, host_key, kind, display_name, transport)
     values ($1, $2, 'local_direct', 'walk host', '{"kind":"local_direct"}')`,
    [hostId, hostKey],
  );
  for (const runId of [earlyRun, lateRun]) {
    const assignmentId = randomUUID();

    assignments.set(runId, assignmentId);
    await testDatabase.pool.query(
      `insert into runs (id, project_id, run_kind, status, flow_version, flow_revision)
       values ($1, $2, 'scratch', 'Pending', 'scratch', 'manual')`,
      [runId, projectId],
    );
    await testDatabase.pool.query(
      `insert into execution_assignments
         (id, run_id, execution_host_id, epoch, state, placement_reason)
       values ($1, $2, $3, 1, 'active', 'launch')`,
      [assignmentId, runId, hostId],
    );
  }
}, 240_000);

afterAll(async () => {
  await testDatabase?.stop();
});

function envelope(sequence: number): Record<string, unknown> {
  const runId = FOREIGN_SEQUENCES.has(sequence)
    ? randomUUID()
    : sequence >= LATE_RUN_FROM
      ? lateRun
      : earlyRun;

  return {
    envelopeVersion: 1,
    eventId: randomUUID(),
    hostKey,
    hostBootId: "3f0c8b2e-5d71-4a9c-b6e2-1c9d7a5f4e20",
    streamId,
    sequence: String(sequence),
    runId,
    assignmentId: assignments.get(runId) ?? randomUUID(),
    assignmentEpoch: 1,
    hostSessionId: "b1e7d3c9-2a4f-4e6b-9c8d-7f5a3e1b2c64",
    eventType: "session.update",
    occurredAt: "2026-09-25T00:00:00.000Z",
    payloadSchema: "maister.session.update.v1",
    payload: { update: { state: `working ${sequence}` } },
  };
}

describe("bounded contiguity walk (ADR-167 amendment 2026-09-25)", () => {
  it("I2: releases 10 000 pending rows in pages, never in one read", async () => {
    const statements: Array<{ query: string; params: unknown[] }> = [];
    const db = drizzle(testDatabase.pool, {
      schema: fullSchema,
      logger: {
        logQuery: (query, params) => statements.push({ query, params }),
      },
    }) as unknown as Db;
    const pageReads = () =>
      statements.filter(({ query }) =>
        /^select .* from "execution_events" where \("execution_events"\."event_stream_id" = \$1 and "execution_events"\."host_sequence" >= \$2 and "execution_events"\."host_sequence" < \$3\) order by "execution_events"\."host_sequence" asc limit \$4$/is.test(
          query,
        ),
      );
    const gapProbes = () =>
      statements.filter(({ query }) =>
        /^select "id" from "execution_events" where \("execution_events"\."event_stream_id" = \$1 and "execution_events"\."host_sequence" > \$2\) order by "execution_events"\."host_sequence" asc limit \$3$/is.test(
          query,
        ),
      );

    // Everything after sequence 0 arrives first and waits behind the gap.
    for (let from = 1; from <= PENDING; from += 1_000) {
      const held = await ingestRuntimeEventBatch({
        db,
        executionHostId: hostId,
        envelopes: Array.from(
          { length: Math.min(1_000, PENDING + 1 - from) },
          (_, index) => envelope(from + index),
        ),
      });

      expect(held.contiguousThrough).toBeNull();
    }
    // The reads the gap filler is about to repeat, measured on the held state
    // (before promotion rewrites every row).
    const heldPage = pageReads().at(-1)!;
    const heldProbe = gapProbes().at(-1)!;

    for (const statement of [heldPage, heldProbe]) {
      const plan = await testDatabase.pool.query<{ "QUERY PLAN": unknown }>(
        `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${statement.query}`,
        statement.params.map((value) =>
          typeof value === "bigint" ? value.toString() : value,
        ),
      );
      const root = (
        plan.rows[0]!["QUERY PLAN"] as Array<{ Plan: PlanNode }>
      )[0]!.Plan;

      expect(JSON.stringify(root)).toContain(
        "execution_events_host_position_uq",
      );
      // No node of the plan touches more than one page of rows.
      expect(maxActualRows(root)).toBeLessThanOrEqual(PROMOTE_READ_ROWS);
    }
    statements.length = 0;
    const filler = await ingestRuntimeEventBatch({
      db,
      executionHostId: hostId,
      envelopes: [envelope(0)],
    });
    const storedRows = PENDING + 1 - FOREIGN_SEQUENCES.size;
    // One window per PROMOTE_READ_ROWS sequence positions, plus the window
    // that finds the head.
    const windows = Math.ceil((PENDING + 1) / PROMOTE_READ_ROWS);

    expect(filler.results[0]!.disposition).toBe("accepted");
    expect(filler.contiguousThrough).toBe(String(PENDING));
    expect(filler.skippedCount).toBe(FOREIGN_SEQUENCES.size);
    expect(filler.acceptedCount).toBe(storedRows);
    expect(new Set(filler.promotedRunIds)).toEqual(
      new Set([earlyRun, lateRun]),
    );
    expect(pageReads().length).toBeGreaterThanOrEqual(windows);
    expect(pageReads().length).toBeLessThanOrEqual(windows + 1);
    for (const read of pageReads())
      expect(read.params.at(-1)).toBe(PROMOTE_READ_ROWS);
    // The work is shaped by pages: a per-row statement anywhere would add
    // ~10 000 to this.
    expect(statements.length).toBeLessThanOrEqual(8 * windows + 40);

    const stored = await testDatabase.pool.query<{
      run_id: string;
      accepted: string;
      max_run_sequence: string;
    }>(
      `select run_id, count(*)::text as accepted,
              max(run_sequence)::text as max_run_sequence
         from execution_events
        where ingest_disposition = 'accepted' group by run_id`,
    );

    expect(
      Object.fromEntries(
        stored.rows.map((row) => [
          row.run_id,
          [row.accepted, row.max_run_sequence],
        ]),
      ),
    ).toEqual({
      // [0, LATE_RUN_FROM) less one foreign sequence; the rest less three.
      [earlyRun]: [String(LATE_RUN_FROM - 1), String(LATE_RUN_FROM - 2)],
      [lateRun]: [
        String(PENDING + 1 - LATE_RUN_FROM - 3),
        String(PENDING + 1 - LATE_RUN_FROM - 4),
      ],
    });
  });
});

type PlanNode = {
  "Node Type": string;
  "Actual Rows": number;
  Plans?: PlanNode[];
};

function maxActualRows(node: PlanNode): number {
  return Math.max(
    node["Actual Rows"],
    ...(node.Plans ?? []).map(maxActualRows),
  );
}
