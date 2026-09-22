import type { Db } from "@/lib/execution-host/db";

import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "@/lib/db/schema";
import { runMessages, runs } from "@/lib/db/schema";
import { projectExecutionEvents } from "@/lib/execution-host/events/projector";
import { canonicalTranscriptProjector } from "@/lib/execution-host/events/transcript-projector";
import { appendScratchMessage } from "@/lib/scratch-runs/messages";
import { parseScratchMessageContent } from "@/lib/scratch-runs/transcript";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

let database: StartedPostgresTestDb;
let db: Db;

beforeAll(async () => {
  database = await startMainPostgresTestDb({
    databaseName: "scratch_transcript",
  });
  db = drizzle(database.pool, { schema });
}, 180_000);
afterAll(async () => {
  await database?.stop();
});
async function seedRun(): Promise<string> {
  const runId = randomUUID();

  await db.insert(runs).values({
    id: runId,
    runKind: "scratch",
    status: "Running",
    flowVersion: "scratch",
    flowRevision: "test",
    executionDataPlaneMode: "canonical_events_v1",
  });
  await db.transaction((tx) =>
    appendScratchMessage(tx, { runId, role: "user", content: "first" }),
  );

  return runId;
}
function textChunk(text: string) {
  return {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text },
  };
}
async function appendEvents(
  runId: string,
  updates: readonly unknown[],
  first: number,
): Promise<void> {
  for (const [index, update] of updates.entries()) {
    const sequence = first + index;

    await database.pool.query(
      `INSERT INTO execution_events (id, source, source_key, run_id, event_type, payload_schema, payload, payload_bytes, occurred_at, run_sequence, ingest_disposition)
      VALUES ($1, 'manager', $2, $3, 'session.update', 'maister.session.update.v1', $4, $5, now(), $6, 'accepted')`,
      [
        randomUUID(),
        String(sequence),
        runId,
        JSON.stringify({ update }),
        Buffer.byteLength(JSON.stringify({ update })),
        sequence,
      ],
    );
  }
}
async function consume(runId: string): Promise<void> {
  const result = await projectExecutionEvents({
    db: db,
    runId,
    projector: canonicalTranscriptProjector,
  });

  expect(result.poisoned).toBe(false);
}
async function cursor(runId: string): Promise<string> {
  const result = await database.pool.query<{ cursor: string }>(
    "SELECT last_run_sequence::text AS cursor FROM execution_event_consumers WHERE run_id = $1 AND consumer_name = $2",
    [runId, canonicalTranscriptProjector.consumerName],
  );

  return result.rows[0].cursor;
}
async function messages(runId: string) {
  return db
    .select()
    .from(runMessages)
    .where(eq(runMessages.runId, runId))
    .orderBy(runMessages.sequence);
}
async function project(updates: readonly unknown[]) {
  const runId = await seedRun();

  await appendEvents(runId, updates, 1);
  await consume(runId);
  expect(await cursor(runId)).toBe(String(updates.length));

  return messages(runId);
}

describe("durable scratch transcript coalescing", () => {
  it("merges streamed assistant chunks into a single bubble", async () => {
    const rows = await project([
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Hel" },
      },
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "lo" },
      },
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: " world" },
      },
    ]);

    const assistant = rows.filter((row) => row.role === "assistant");

    expect(assistant).toHaveLength(1);
    expect(assistant[0].content).toBe("Hello world");
  });

  it("resumes follow-up projection after the latest coalesced assistant chunk", async () => {
    const runId = await seedRun();

    await appendEvents(runId, [textChunk("Previous "), textChunk("answer")], 1);
    await consume(runId);
    expect(await cursor(runId)).toBe("2");
    await db.transaction((tx) =>
      appendScratchMessage(tx, {
        runId,
        role: "user",
        content: "follow-up",
      }),
    );
    await appendEvents(runId, [textChunk("New reply")], 3);
    await consume(runId);
    await consume(runId);
    expect(await cursor(runId)).toBe("3");
    expect(
      (await messages(runId))
        .filter((row) => row.role === "assistant")
        .map((row) => row.content),
    ).toEqual(["Previous answer", "New reply"]);
  });

  it("merges tool_call and its updates into one tool row", async () => {
    const rows = await project([
      {
        sessionUpdate: "tool_call",
        toolCallId: "toolu_1",
        status: "pending",
        rawInput: { command: "git status" },
        content: [],
        _meta: { claudeCode: { toolName: "Bash" } },
      },
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "toolu_1",
        status: "in_progress",
      },
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "toolu_1",
        status: "completed",
        content: [
          { type: "content", content: { type: "text", text: "clean" } },
        ],
      },
    ]);

    const tools = rows.filter((row) => row.role === "tool");

    expect(tools).toHaveLength(1);
    const parsed = parseScratchMessageContent("tool", tools[0].content);

    expect(parsed).toMatchObject({
      kind: "tool",
      tool: {
        name: "Bash",
        arg: "git status",
        status: "completed",
        result: "clean",
      },
    });
  });

  it("starts a new assistant bubble after an interleaved tool call", async () => {
    const rows = await project([
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "before" },
      },
      {
        sessionUpdate: "tool_call",
        toolCallId: "toolu_1",
        status: "completed",
        content: [],
        _meta: { claudeCode: { toolName: "Read" } },
      },
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "after" },
      },
    ]);

    const assistant = rows.filter((row) => row.role === "assistant");

    expect(assistant.map((row) => row.content)).toEqual(["before", "after"]);
    expect(rows.filter((row) => row.role === "tool")).toHaveLength(1);
  });

  it("keeps a single coalesced usage row", async () => {
    const rows = await project([
      { sessionUpdate: "usage_update", used: 10, size: 100 },
      { sessionUpdate: "usage_update", used: 20, size: 100 },
    ]);

    const usage = rows.filter((row) => row.role === "system");

    expect(usage).toHaveLength(1);
    expect(parseScratchMessageContent("system", usage[0].content)).toEqual({
      kind: "usage",
      used: 20,
      size: 100,
    });
  });
});

it("assigns gap-free unique sequences to a burst of projected events", async () => {
  const rows = await project(
    Array.from({ length: 6 }, (_, index) => ({
      sessionUpdate: "tool_call",
      toolCallId: `tc-${index}`,
      title: "Bash",
      kind: "execute",
      status: "pending",
      rawInput: { command: `cmd ${index}` },
      content: [],
    })),
  );

  expect(rows.map((row) => row.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  expect(rows.filter((row) => row.role === "tool")).toHaveLength(6);
});
