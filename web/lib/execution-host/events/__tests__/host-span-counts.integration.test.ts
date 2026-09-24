// ADR-167 D5 amendment (2026-09-23), D-C2: the per-host host-span settlement
// counts on /admin/execution-host. Every assertion is scoped to a host this
// file seeded (never a table-wide total), and the unconfirmed count is tested
// closing as well as opening. The two state counts are disjoint, every count
// is windowed on `completed_at` from the read model's own `now`, and an
// unretired host with nothing in the window is listed with explicit zeros.
import type { PlatformStatus } from "@/types/platform-status";

import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  collectExecutionEventLag,
  hostSpanQuery,
} from "@/lib/execution-host/events/lag-read-model";
import { COMMAND_REPLAY_GRACE_DAYS } from "@/lib/execution-host/retirement";
import {
  seedLocalHost,
  seedProject,
  seedRun,
} from "@/test-support/execution-host-seed";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";
import { HOST_SPAN_ANOMALY_WINDOW_DAYS } from "@/types/execution-host-observability";

const NOW = new Date();
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

let database: StartedPostgresTestDb;
let projectId: string;
let hostA: string;
let hostB: string;
let hostAKey: string;
let hostBKey: string;
let health: PlatformStatus;
let unconfirmedOnA: string;
let unconfirmedEventOnA: string;

async function seedHost(
  local: boolean,
): Promise<{ id: string; hostKey: string }> {
  if (local) return seedLocalHost(database.db);
  const id = randomUUID();
  const hostKey = `eh_${randomUUID().replaceAll("-", "")}`;

  await database.db.execute(sql`
    INSERT INTO execution_hosts (id, host_key, kind, display_name, transport, retired_at)
    VALUES (${id}, ${hostKey}, 'local_direct',
            'retired host', '{"kind":"local_direct"}', now())
  `);

  return { id, hostKey };
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
  /** Quarantined after settlement, before or after the owner applied it. */
  conflict?: "applied" | "unapplied";
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
      ${
        input.conflict === "applied"
          ? "applied"
          : input.conflict === "unapplied"
            ? "poisoned"
            : "pending"
      },
      ${input.conflict === "applied" ? input.completedAt : null},
      ${
        input.conflict
          ? JSON.stringify({
              reason: "prompt_terminal_conflict",
              phase: "prepare",
              causeCode:
                input.conflict === "applied"
                  ? "terminal_v2_agreement"
                  : "event_binding",
            })
          : null
      }::jsonb
    )
  `);

  return { commandId, eventId };
}

/** Absent means the read model did not list the host — never read as zero. */
async function countsFor(hostId: string, now: Date = NOW) {
  const model = await collectExecutionEventLag({
    db: database.db,
    health,
    now,
  });

  return model.commands.hostSpan.find((row) => row.executionHostId === hostId);
}

beforeAll(async () => {
  database = await startMainPostgresTestDb({
    databaseName: "execution_host_span_counts",
  });
  projectId = await seedProject(database.db);
  ({ id: hostA, hostKey: hostAKey } = await seedHost(true));
  ({ id: hostB, hostKey: hostBKey } = await seedHost(false));
  health = { kind: "unavailable" } as unknown as PlatformStatus;

  const opened = await settledPrompt({
    hostId: hostA,
    settledFrom: "host_span",
    bound: false,
    completedAt: NOW,
  });

  unconfirmedOnA = opened.commandId;
  unconfirmedEventOnA = opened.eventId;
  // Confirmed and older than the hour: in no count.
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
    conflict: "applied",
  });
  // Refused before the canonical event bound: unbound AND quarantined — a
  // conflict, never also "awaiting canonical event".
  await settledPrompt({
    hostId: hostA,
    settledFrom: "host_span",
    bound: false,
    completedAt: new Date(NOW.getTime() - 30 * MINUTE),
    conflict: "unapplied",
  });
  // Unconfirmed for days: still inside the anomaly window.
  await settledPrompt({
    hostId: hostA,
    settledFrom: "host_span",
    bound: false,
    completedAt: new Date(NOW.getTime() - 3 * DAY),
  });
  // Past the anomaly window: the retirement pass reports these, not the page.
  for (const conflict of [undefined, "applied", "applied"] as const)
    await settledPrompt({
      hostId: hostA,
      settledFrom: "host_span",
      bound: conflict !== undefined,
      completedAt: new Date(NOW.getTime() - 8 * DAY),
      conflict,
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
  it("windows the state counts on the retirement pass's replay grace", () => {
    expect(HOST_SPAN_ANOMALY_WINDOW_DAYS).toBe(COMMAND_REPLAY_GRACE_DAYS);
  });

  it("counts each host's own host-span rows: disjoint state counts, windowed, canonical rows excluded", async () => {
    expect(await countsFor(hostA)).toEqual({
      executionHostId: hostA,
      hostKey: hostAKey,
      displayName: "test local host",
      hostSpanUnconfirmed: 2,
      hostSpanSettled1h: 3,
      postHocConflicts: 2,
    });
    expect(await countsFor(hostB)).toEqual({
      executionHostId: hostB,
      hostKey: hostBKey,
      displayName: "retired host",
      hostSpanUnconfirmed: 1,
      hostSpanSettled1h: 1,
      postHocConflicts: 0,
    });
  });

  it("anchors the one-hour window at the read model's now, not the database clock", async () => {
    expect(
      (await countsFor(hostA, new Date(NOW.getTime() + 45 * MINUTE)))
        ?.hostSpanSettled1h,
    ).toBe(2);
  });

  it("closes: the canonical confirmation takes a row out of the unconfirmed count", async () => {
    await database.db.execute(sql`
      UPDATE execution_commands SET terminal_event_id = ${unconfirmedEventOnA}
      WHERE id = ${unconfirmedOnA}
    `);

    expect(await countsFor(hostA)).toMatchObject({
      hostSpanUnconfirmed: 1,
      hostSpanSettled1h: 3,
    });
    expect((await countsFor(hostB))?.hostSpanUnconfirmed).toBe(1);
  });

  it("lists an unretired host with nothing in the window as explicit zeros, and drops a retired one", async () => {
    const later = new Date(NOW.getTime() + 30 * DAY);

    expect(await countsFor(hostA, later)).toMatchObject({
      hostSpanUnconfirmed: 0,
      hostSpanSettled1h: 0,
      postHocConflicts: 0,
    });
    expect(await countsFor(hostB, later)).toBeUndefined();
  });

  // `enable_seqscan = off` makes the planner take any usable index on this
  // tiny table, so this proves only that the window is an INDEX CONDITION of
  // the partial index — the scan is bounded by the window instead of reading
  // every host-span row ever written — not which plan production picks.
  it("bounds the scan by the window through the partial host-span index", async () => {
    const plan = await database.db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL enable_seqscan = off`);
      const explained = await tx.execute<{ "QUERY PLAN": unknown }>(
        sql`EXPLAIN (FORMAT JSON) ${hostSpanQuery(NOW)}`,
      );

      return explained.rows[0]?.["QUERY PLAN"];
    });
    const scans: Record<string, unknown>[] = [];
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (node === null || typeof node !== "object") return;
      const record = node as Record<string, unknown>;

      if (record["Index Name"] === "execution_commands_host_span_settled_idx")
        scans.push(record);
      Object.values(record).forEach(walk);
    };

    walk(plan);
    expect(scans.length).toBeGreaterThan(0);
    for (const scan of scans)
      expect(String(scan["Index Cond"])).toMatch(/completed_at >/);
  });
});
