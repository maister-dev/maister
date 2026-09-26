import type { Db } from "@/lib/execution-host/db";

import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "@/lib/db/schema";
import { runMessages, runs } from "@/lib/db/schema";
import { projectExecutionEvents } from "@/lib/execution-host/events/projector";
import { canonicalTranscriptProjector } from "@/lib/execution-host/events/transcript-projector";
import { canonicalPromptProjector } from "@/lib/execution-host/events/prompt-projector";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

// ADR-182 T2.4 (RED S8, C29): a `session.command{kind: session.steer}` pair
// never holds the stream — the prompt projector steps over it — and its
// acceptance is a transcript boundary for EVERY run kind that closes the open
// assistant rows without restarting the turn's usage row.

let database: StartedPostgresTestDb;
let db: Db;

beforeAll(async () => {
  database = await startMainPostgresTestDb({
    databaseName: "steer_transcript_boundary",
  });
  db = drizzle(database.pool, { schema }) as unknown as Db;
}, 180_000);

afterAll(async () => {
  await database?.stop();
});

async function seedRun(kind: "scratch" | "agent"): Promise<string> {
  const runId = randomUUID();

  await db.insert(runs).values({
    id: runId,
    runKind: kind,
    status: "Running",
    flowVersion: kind,
    flowRevision: "test",
    executionDataPlaneMode: "canonical_events_v1",
    ...(kind === "agent" ? { persistent: true } : {}),
  });

  return runId;
}

type Row =
  | { eventType: "session.update"; payload: { update: unknown } }
  | { eventType: "session.command"; payload: Record<string, unknown> };

async function appendEvents(runId: string, rows: readonly Row[]) {
  for (const [index, row] of rows.entries()) {
    const sequence = index + 1;
    const schemaName =
      row.eventType === "session.update"
        ? "maister.session.update.v1"
        : "maister.session.command.v1";

    await database.pool.query(
      `INSERT INTO execution_events (id, source, source_key, run_id, event_type, payload_schema, payload, payload_bytes, occurred_at, run_sequence, ingest_disposition)
      VALUES ($1, 'manager', $2, $3, $4, $5, $6, $7, now(), $8, 'accepted')`,
      [
        randomUUID(),
        String(sequence),
        runId,
        row.eventType,
        schemaName,
        JSON.stringify(row.payload),
        Buffer.byteLength(JSON.stringify(row.payload)),
        sequence,
      ],
    );
  }
}

const text = (value: string): Row => ({
  eventType: "session.update",
  payload: {
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: value },
    },
  },
});
const usage = (used: number): Row => ({
  eventType: "session.update",
  payload: { update: { sessionUpdate: "usage_update", used, size: 100 } },
});
const command = (
  kind: string,
  phase: "accepted" | "completed",
  commandId: string,
): Row => ({
  eventType: "session.command",
  payload: {
    commandId,
    kind,
    phase,
    ...(phase === "completed"
      ? {
          status: "succeeded",
          result: { outcome: "injected", parentCommandId: randomUUID() },
        }
      : {}),
  },
});

async function project(runId: string) {
  for (const projector of [
    canonicalTranscriptProjector,
    canonicalPromptProjector,
  ]) {
    const result = await projectExecutionEvents({ db, runId, projector });

    expect(result.poisoned).toBe(false);
  }
  const consumers = await database.pool.query<{
    name: string;
    cursor: string;
  }>(
    "SELECT consumer_name AS name, last_run_sequence::text AS cursor FROM execution_event_consumers WHERE run_id = $1 ORDER BY consumer_name",
    [runId],
  );
  const skips = await database.pool.query(
    "SELECT 1 FROM execution_event_skips WHERE run_id = $1",
    [runId],
  );

  return {
    consumers: consumers.rows,
    skips: skips.rowCount,
    rows: await db
      .select()
      .from(runMessages)
      .where(eq(runMessages.runId, runId))
      .orderBy(runMessages.sequence),
  };
}

describe("session.steer on the canonical event plane (ADR-182)", () => {
  it.each(["scratch", "agent"] as const)(
    "a %s run keeps text around a steer apart and one usage row per turn",
    async (kind) => {
      const runId = await seedRun(kind);
      const steer = randomUUID();

      await appendEvents(runId, [
        text("before "),
        usage(10),
        command("session.steer", "accepted", steer),
        text("after"),
        usage(20),
        command("session.steer", "completed", steer),
      ]);
      const { consumers, skips, rows } = await project(runId);

      expect(skips).toBe(0);
      expect(consumers.every((consumer) => consumer.cursor === "6")).toBe(true);
      expect(
        rows
          .filter((row) => row.role === "assistant")
          .map((row) => row.content),
      ).toEqual(["before ", "after"]);
      expect(rows.filter((row) => row.role === "system")).toHaveLength(1);
    },
    60_000,
  );

  it("still restarts a scratch usage row at any other command boundary", async () => {
    const runId = await seedRun("scratch");

    await appendEvents(runId, [
      usage(10),
      command("session.prompt", "accepted", randomUUID()),
      usage(20),
    ]);
    const { rows } = await project(runId);

    expect(rows.filter((row) => row.role === "system")).toHaveLength(2);
  }, 60_000);
});
