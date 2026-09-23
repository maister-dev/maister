// ADR-167 D5 amendment (2026-09-23), D-C2: the per-host host-span settlement
// counts on /admin/execution-host. Every assertion is scoped to a host this
// file seeded (never a table-wide total), and the unconfirmed count is tested
// closing as well as opening.
import type { PlatformStatus } from "@/types/platform-status";

import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  collectExecutionEventLag,
  hostSpanQuery,
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

const NOW = new Date();
const HOUR = 60 * 60 * 1000;

let database: StartedPostgresTestDb;
let projectId: string;
let hostA: string;
let hostB: string;
let health: PlatformStatus;
let unconfirmedOnA: string;
let unconfirmedEventOnA: string;

async function seedHost(local: boolean): Promise<string> {
  if (local) return (await seedLocalHost(database.db)).id;
  const id = randomUUID();

  await database.db.execute(sql`
    INSERT INTO execution_hosts (id, host_key, kind, display_name, transport, retired_at)
    VALUES (${id}, ${`eh_${randomUUID().replaceAll("-", "")}`}, 'local_direct',
            'second host', '{"kind":"local_direct"}', now())
  `);

  return id;
}

async function terminalEvent(runId: string): Promise<string> {
  const id = randomUUID();

  await database.db.execute(sql`
    INSERT INTO execution_events (
      id, source, source_key, run_id, event_type, payload_schema,
      occurred_at, received_at, ingest_disposition
    ) VALUES (
      ${id}, 'manager', ${`terminal-${id}`}, ${runId}, 'session.command',
      'maister.test.v1', ${NOW}, ${NOW}, 'accepted'
    )
  `);

  return id;
}

/** One settled v1 prompt row with the given settlement shape. */
async function settledPrompt(input: {
  hostId: string;
  settledFrom: "canonical" | "host_span";
  bound: boolean;
  completedAt: Date;
  postHocConflict?: boolean;
}): Promise<{ commandId: string; eventId: string }> {
  const runId = await seedRun(database.db, { projectId, status: "Running" });
  const assignmentId = randomUUID();
  const commandId = randomUUID();
  const eventId = await terminalEvent(runId);

  await database.db.execute(sql`
    INSERT INTO execution_assignments (id, run_id, execution_host_id, epoch, state, placement_reason)
    VALUES (${assignmentId}, ${runId}, ${input.hostId}, 1, 'active', 'launch')
  `);
  await database.db.execute(sql`
    INSERT INTO execution_commands (
      id, run_id, execution_assignment_id, execution_host_id, assignment_epoch,
      kind, target_session_id, payload, max_attempts, owner_kind, owner_ref,
      logical_operation_key, request_schema, request_sha256, state, accepted_at,
      completed_at, result, receipt_evidence, terminal_event_id,
      terminal_evidence_sha256, settled_from, application_state,
      completion_applied_at, application_error
    ) VALUES (
      ${commandId}, ${runId}, ${assignmentId}, ${input.hostId}, 1,
      'session.prompt', 'sess-1', '{}'::jsonb, 3, 'flow_node_attempt',
      ${JSON.stringify({
        version: 1,
        variant: "node",
        nodeAttemptId: randomUUID(),
        promptOrdinal: 0,
        runId,
        runSessionId: randomUUID(),
        incarnationId: randomUUID(),
        assignmentId,
        assignmentEpoch: 1,
      })}::jsonb,
      ${`flow_node_attempt:node:${commandId}:0`}, 'maister.command.request.v1',
      ${"a".repeat(64)}, 'succeeded', ${input.completedAt}, ${input.completedAt},
      '{"stopReason":"end_turn"}'::jsonb,
      ${JSON.stringify({
        commandId,
        runId,
        kind: "session.prompt",
        assignmentEpoch: 1,
        phase: "completed",
      })}::jsonb,
      ${input.bound ? eventId : null}, ${"b".repeat(64)}, ${input.settledFrom},
      ${input.postHocConflict ? "applied" : "pending"},
      ${input.postHocConflict ? input.completedAt : null},
      ${
        input.postHocConflict
          ? JSON.stringify({
              reason: "prompt_terminal_conflict",
              phase: "prepare",
              causeCode: "terminal_v2_agreement",
            })
          : null
      }::jsonb
    )
  `);

  return { commandId, eventId };
}

async function countsFor(hostId: string) {
  const model = await collectExecutionEventLag({ db: database.db, health });

  return (
    model.commands.hostSpan.find((row) => row.executionHostId === hostId) ?? {
      executionHostId: hostId,
      hostSpanUnconfirmed: 0,
      hostSpanSettled1h: 0,
      postHocConflicts: 0,
    }
  );
}

beforeAll(async () => {
  database = await startMainPostgresTestDb({
    databaseName: "execution_host_span_counts",
  });
  projectId = await seedProject(database.db);
  hostA = await seedHost(true);
  hostB = await seedHost(false);
  health = { kind: "unavailable" } as unknown as PlatformStatus;

  const opened = await settledPrompt({
    hostId: hostA,
    settledFrom: "host_span",
    bound: false,
    completedAt: NOW,
  });

  unconfirmedOnA = opened.commandId;
  unconfirmedEventOnA = opened.eventId;
  // Confirmed and older than the window: in neither count.
  await settledPrompt({
    hostId: hostA,
    settledFrom: "host_span",
    bound: true,
    completedAt: new Date(NOW.getTime() - 2 * HOUR),
  });
  // Applied, then the canonical event disagreed.
  await settledPrompt({
    hostId: hostA,
    settledFrom: "host_span",
    bound: true,
    completedAt: NOW,
    postHocConflict: true,
  });
  // A canonical settlement never counts.
  await settledPrompt({
    hostId: hostA,
    settledFrom: "canonical",
    bound: true,
    completedAt: NOW,
  });
  await settledPrompt({
    hostId: hostB,
    settledFrom: "host_span",
    bound: false,
    completedAt: NOW,
  });
}, 180_000);

afterAll(async () => {
  await database?.stop();
});

describe("host-span settlement counts (D-C2)", () => {
  it("counts each host's own host-span rows, excluding canonical rows and the aged-out window", async () => {
    expect(await countsFor(hostA)).toEqual({
      executionHostId: hostA,
      hostSpanUnconfirmed: 1,
      hostSpanSettled1h: 2,
      postHocConflicts: 1,
    });
    expect(await countsFor(hostB)).toEqual({
      executionHostId: hostB,
      hostSpanUnconfirmed: 1,
      hostSpanSettled1h: 1,
      postHocConflicts: 0,
    });
  });

  it("closes: the canonical confirmation takes a row out of the unconfirmed count", async () => {
    await database.db.execute(sql`
      UPDATE execution_commands SET terminal_event_id = ${unconfirmedEventOnA}
      WHERE id = ${unconfirmedOnA}
    `);

    expect(await countsFor(hostA)).toMatchObject({
      hostSpanUnconfirmed: 0,
      hostSpanSettled1h: 2,
    });
    expect((await countsFor(hostB)).hostSpanUnconfirmed).toBe(1);
  });

  it("is served by the partial host-span index", async () => {
    const plan = await database.db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL enable_seqscan = off`);
      const explained = await tx.execute<{ "QUERY PLAN": unknown }>(
        sql`EXPLAIN (FORMAT JSON) ${hostSpanQuery()}`,
      );

      return JSON.stringify(explained.rows);
    });

    expect(plan).toContain("execution_commands_host_span_settled_idx");
  });
});
