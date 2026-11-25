import { randomUUID } from "node:crypto";

import { and, asc, eq } from "drizzle-orm";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { MAX_COMPACTION_SUMMARY_LENGTH } from "../../../../runtime/acp-context";

import * as fullSchema from "@/lib/db/schema";
import { projectExecutionEvents } from "@/lib/execution-host/events/projector";
import {
  canonicalTranscriptProjector,
  projectTranscriptEvent,
} from "@/lib/execution-host/events/transcript-projector";
import { coalesceSessionUpdates } from "@/lib/run-transcript/coalesce";
import { parseScratchMessageContent } from "@/lib/run-transcript/transcript";
import {
  getWholeRunTranscriptMessages,
  getRunNodeTranscript,
  projectRunTranscript,
} from "@/lib/runs/run-transcript-projector";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const schema = fullSchema as unknown as Record<string, any>;

type Db = NodePgDatabase<typeof fullSchema>;

let testDatabase: StartedPostgresTestDb;
let db: Db;

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "maister_transcript_projector_test",
  });
  db = testDatabase.db as unknown as Db;
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

function textLine(nodeAttemptId: string, monotonicId: number, text: string) {
  return JSON.stringify({
    type: "session.update",
    monotonicId,
    sessionName: "node",
    nodeAttemptId,
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text },
    },
  });
}

function wholeRunTextLine(monotonicId: number, text: string) {
  return JSON.stringify({
    type: "session.update",
    monotonicId,
    sessionName: "default",
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text },
    },
  });
}

function toolLine(nodeAttemptId: string, monotonicId: number) {
  return JSON.stringify({
    type: "session.update",
    monotonicId,
    sessionName: "node",
    nodeAttemptId,
    update: {
      sessionUpdate: "tool_call",
      toolCallId: "call-1",
      title: "Edit file",
      kind: "edit",
      status: "completed",
      content: [],
    },
  });
}

function usageLine(nodeAttemptId: string, monotonicId: number, used: number) {
  return JSON.stringify({
    type: "session.update",
    monotonicId,
    sessionName: "node",
    nodeAttemptId,
    update: { sessionUpdate: "usage_update", used, size: 200000 },
  });
}

async function seed(
  executionDataPlaneMode: "canonical_events_v1" = "canonical_events_v1",
): Promise<{
  runId: string;
  slug: string;
  planAttemptId: string;
  implAttemptId: string;
}> {
  const projectId = randomUUID();
  const runId = randomUUID();
  const slug = `proj-${projectId.slice(0, 8)}`;

  await db.insert(schema.projects).values({
    id: projectId,
    taskKey: `T${projectId.slice(0, 8)}`.toUpperCase(),
    slug,
    name: `Project ${slug}`,
    repoPath: `/tmp/${slug}`,
    maisterYamlPath: `/tmp/${slug}/maister.yaml`,
  });
  await db.insert(schema.runs).values({
    id: runId,
    projectId,
    runKind: "flow",
    status: "Running",
    executionDataPlaneMode,
    flowVersion: "v1",
    flowRevision: "manual",
  });

  const planAttemptId = randomUUID();
  const implAttemptId = randomUUID();

  await db.insert(schema.nodeAttempts).values([
    {
      id: planAttemptId,
      runId,
      nodeId: "plan",
      nodeType: "ai_coding",
      attempt: 1,
      status: "Succeeded",
    },
    {
      id: implAttemptId,
      runId,
      nodeId: "implement",
      nodeType: "ai_coding",
      attempt: 1,
      status: "Running",
    },
  ]);

  return { runId, slug, planAttemptId, implAttemptId };
}

async function seedStandaloneAgentRun(): Promise<{
  runId: string;
  slug: string;
}> {
  const projectId = randomUUID();
  const runId = randomUUID();
  const slug = `agent-${projectId.slice(0, 8)}`;

  await db.insert(schema.projects).values({
    id: projectId,
    taskKey: `A${projectId.slice(0, 8)}`.toUpperCase(),
    slug,
    name: `Project ${slug}`,
    repoPath: `/tmp/${slug}`,
    maisterYamlPath: `/tmp/${slug}/maister.yaml`,
  });
  await db.insert(schema.runs).values({
    id: runId,
    projectId,
    runKind: "agent",
    status: "Running",
    flowVersion: "v1",
    flowRevision: "manual",
  });

  return { runId, slug };
}

async function writeEvents(_slug: string, runId: string, lines: string[]) {
  for (const line of lines) {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    const monotonicId = parsed.monotonicId;

    if (typeof monotonicId !== "number") {
      throw new Error("canonical transcript fixture requires a monotonic id");
    }
    const type = parsed.type;
    const payload = Object.fromEntries(
      Object.entries(parsed).filter(
        ([key]) =>
          !["type", "monotonicId", "sessionName", "hostSessionId"].includes(
            key,
          ),
      ),
    );

    if (typeof type !== "string") {
      throw new Error("canonical transcript fixture requires an event type");
    }
    await db
      .insert(schema.executionEvents)
      .values({
        id: randomUUID(),
        source: "manager",
        sourceKey: `canonical-transcript:${runId}:${monotonicId}`,
        runId,
        ...(typeof parsed.hostSessionId === "string"
          ? { hostSessionId: parsed.hostSessionId }
          : {}),
        eventType: type,
        payloadSchema: `maister.${type}.v1`,
        payload,
        occurredAt: new Date(),
        receivedAt: new Date(),
        runSequence: BigInt(monotonicId),
        ingestDisposition: "accepted",
      })
      .onConflictDoNothing();
  }
}

describe("projectRunTranscript", () => {
  it("retains one ordered compaction marker through streamed text and terminal enrichment", async () => {
    const { runId, slug, implAttemptId } = await seed();
    const compaction = (monotonicId: number, update: Record<string, unknown>) =>
      JSON.stringify({
        type: "session.update",
        monotonicId,
        nodeAttemptId: implAttemptId,
        update: {
          sessionUpdate: "compaction_update",
          compactionId: "compact-1",
          ...update,
        },
      });

    await writeEvents(slug, runId, [
      textLine(implAttemptId, 1, "Before"),
      compaction(2, { status: "in_progress" }),
      compaction(3, {
        sessionUpdate: "compaction_summary_chunk",
        content: { type: "text", text: "Draft" },
      }),
      compaction(4, { status: "completed" }),
      textLine(implAttemptId, 5, "After"),
    ]);
    await projectRunTranscript(runId, { client: db });
    const first = await getRunNodeTranscript(runId, "implement", {
      client: db,
    });

    expect(first?.messages.map(({ role }) => role)).toEqual([
      "assistant",
      "system",
      "assistant",
    ]);
    const marker = first!.messages[1]!;

    expect(JSON.parse(marker.content)).toMatchObject({
      kind: "compaction",
      status: "completed",
      summary: "Draft",
    });

    await writeEvents(slug, runId, [
      compaction(6, {
        status: "completed",
        summary: [{ type: "text", text: "Final summary" }],
      }),
      compaction(7, { status: "failed", error: "Conflicting terminal" }),
    ]);
    await projectRunTranscript(runId, { client: db });
    const enriched = await getRunNodeTranscript(runId, "implement", {
      client: db,
    });

    expect(enriched?.messages.map(({ id }) => id)).toEqual(
      first?.messages.map(({ id }) => id),
    );
    expect(JSON.parse(enriched!.messages[1]!.content)).toMatchObject({
      kind: "compaction",
      status: "completed",
      summary: "Final summary",
    });
  });

  it("retains bounded Unicode summary text and projects the exit after it", async () => {
    const { runId, slug, implAttemptId } = await seed();
    const hostSessionId = "compaction-unicode";
    const prefix = "я".repeat(MAX_COMPACTION_SUMMARY_LENGTH - 1);
    const update = (monotonicId: number, value: Record<string, unknown>) =>
      JSON.stringify({
        type: "session.update",
        hostSessionId,
        nodeAttemptId: implAttemptId,
        monotonicId,
        update: { compactionId: "unicode", ...value },
      });

    await writeEvents(slug, runId, [
      update(1, { sessionUpdate: "compaction_update", status: "in_progress" }),
      update(2, {
        sessionUpdate: "compaction_summary_chunk",
        content: { type: "text", text: prefix },
      }),
      update(3, {
        sessionUpdate: "compaction_summary_chunk",
        content: { type: "text", text: "😀" },
      }),
      update(4, {
        sessionUpdate: "compaction_summary_chunk",
        content: { type: "text", text: "x" },
      }),
      update(5, {
        sessionUpdate: "compaction_update",
        compactionId: "legacy",
        status: "in_progress",
      }),
    ]);
    await projectRunTranscript(runId, { client: db });
    const legacySummary = "Legacy content \uD83D";

    // Reproduce a marker persisted before prospective Unicode-safe writes.
    await db
      .update(fullSchema.runMessages)
      .set({
        content: JSON.stringify({
          v: 1,
          kind: "compaction",
          status: "in_progress",
          summary: legacySummary,
        }),
      })
      .where(
        and(
          eq(fullSchema.runMessages.runId, runId),
          eq(fullSchema.runMessages.firstSupervisorEventId, "5"),
        ),
      );
    await writeEvents(slug, runId, [
      JSON.stringify({
        type: "session.exited",
        hostSessionId,
        nodeAttemptId: implAttemptId,
        monotonicId: 6,
      }),
      textLine(implAttemptId, 7, "After interruption"),
    ]);
    await projectRunTranscript(runId, { client: db });
    const projected = await getRunNodeTranscript(runId, "implement", {
      client: db,
    });

    expect(projected?.messages).toHaveLength(3);
    expect(JSON.parse(projected!.messages[0]!.content)).toMatchObject({
      kind: "compaction",
      status: "interrupted",
      summary: prefix,
    });
    const legacy = parseScratchMessageContent(
      "system",
      projected!.messages[1]!.content,
    );

    expect(legacy).toMatchObject({
      kind: "compaction",
      status: "interrupted",
      summary: legacySummary,
    });
    expect(projected!.messages[2]!.content).toBe("After interruption");
  });

  it("keeps text and tool coalescing stable across bounded projection quanta", async () => {
    const { runId, slug, implAttemptId } = await seed();
    const lines = Array.from({ length: 220 }, (_, index) => {
      if (index === 0) return toolLine(implAttemptId, index + 1);
      if (index === 100 || index === 200)
        return JSON.stringify({
          type: "session.update",
          monotonicId: index + 1,
          nodeAttemptId: implAttemptId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "call-1",
            status: "completed",
            content: [
              {
                type: "content",
                content: { type: "text", text: `result-${index}` },
              },
            ],
          },
        });

      return textLine(implAttemptId, index + 1, "x");
    });

    await writeEvents(slug, runId, lines);
    await expect
      .poll(
        async () => {
          await projectRunTranscript(runId, { client: db });
          const [cursor] = await db
            .select({
              last: fullSchema.executionEventConsumers.lastRunSequence,
            })
            .from(fullSchema.executionEventConsumers)
            .where(eq(fullSchema.executionEventConsumers.runId, runId));

          return cursor?.last;
        },
        { timeout: 15_000 },
      )
      .toBe(220n);
    const actual = await getRunNodeTranscript(runId, "implement", {
      client: db,
    });
    const expected = coalesceSessionUpdates(
      lines.map((line, index) => ({
        kind: "update",
        update: (JSON.parse(line) as { update: unknown }).update,
        supervisorEventId: String(index + 1),
      })),
    );
    const content = (message: { role: string; content: string }): unknown =>
      message.role === "assistant"
        ? message.content
        : JSON.parse(message.content);

    expect(
      actual?.messages.map((message) => ({
        role: message.role,
        content: content(message),
      })),
    ).toEqual(
      expected.map((message) => ({
        role: message.role,
        content: content(message),
      })),
    );
  });

  it("projects a canonical transcript from Postgres without reading the host runtime directory", async () => {
    const { runId, implAttemptId } = await seed("canonical_events_v1");

    await db.insert(schema.executionEvents).values([
      {
        id: randomUUID(),
        source: "manager",
        sourceKey: "canonical-transcript:0",
        runId,
        eventType: "session.update",
        payloadSchema: "maister.session.update.v1",
        payload: {
          nodeAttemptId: implAttemptId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "canonical " },
          },
        },
        occurredAt: new Date(),
        receivedAt: new Date(),
        runSequence: BigInt(0),
        ingestDisposition: "accepted",
      },
      {
        id: randomUUID(),
        source: "manager",
        sourceKey: "canonical-transcript:1",
        runId,
        eventType: "session.update",
        payloadSchema: "maister.session.update.v1",
        payload: {
          nodeAttemptId: implAttemptId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "event" },
          },
        },
        occurredAt: new Date(),
        receivedAt: new Date(),
        runSequence: BigInt(1),
        ingestDisposition: "accepted",
      },
    ]);

    const result = await projectRunTranscript(runId, {
      client: db,
    });
    const transcript = await getRunNodeTranscript(runId, "implement", {
      client: db,
    });

    expect(result).toMatchObject({ status: "projected", nodeAttempts: 1 });
    expect(transcript?.messages).toEqual([
      expect.objectContaining({
        role: "assistant",
        content: "canonical event",
      }),
    ]);
  });

  it("attributes coalesced messages to the right node attempt and is idempotent", async () => {
    const { runId, slug, planAttemptId, implAttemptId } = await seed();

    await writeEvents(slug, runId, [
      textLine(planAttemptId, 1, "Plan "),
      textLine(planAttemptId, 2, "ready."),
      textLine(implAttemptId, 3, "Editing..."),
      toolLine(implAttemptId, 4),
      usageLine(implAttemptId, 5, 1234),
    ]);

    const first = await projectRunTranscript(runId, {
      client: db,
    });

    expect(first.status).toBe("projected");
    expect(first.nodeAttempts).toBe(2);

    // plan: one coalesced assistant message.
    const plan = await getRunNodeTranscript(runId, "plan", { client: db });

    expect(plan?.messages).toHaveLength(1);
    expect(plan?.messages[0]).toMatchObject({
      role: "assistant",
      content: "Plan ready.",
    });

    // implement: assistant text + tool + usage(system); usage surfaced.
    const impl = await getRunNodeTranscript(runId, "implement", { client: db });

    expect(impl?.messages.map((m) => m.role)).toEqual([
      "assistant",
      "tool",
      "system",
    ]);
    expect(impl?.usage).toMatchObject({ used: 1234 });

    // Idempotent: re-projection with no new events is a no-op; row count holds.
    const again = await projectRunTranscript(runId, {
      client: db,
    });

    expect(again.status).toBe("unchanged");

    const planAfter = await getRunNodeTranscript(runId, "plan", { client: db });

    expect(planAfter?.messages).toHaveLength(1);
  });

  it("stays 'unchanged' when only a run-level line (no nodeAttemptId) is appended", async () => {
    const { runId, slug, planAttemptId } = await seed();

    await writeEvents(slug, runId, [textLine(planAttemptId, 1, "plan output")]);
    await projectRunTranscript(runId, { client: db });

    // A run-level marker (e.g. `run.needs_input`) advances the file's max
    // monotonicId but carries no nodeAttemptId, so it must not re-trigger
    // projection — otherwise a run in NeedsInput re-derives on every read.
    await writeEvents(slug, runId, [
      textLine(planAttemptId, 1, "plan output"),
      JSON.stringify({ type: "run.needs_input", monotonicId: 999 }),
    ]);

    const again = await projectRunTranscript(runId, {
      client: db,
    });

    expect(again.status).toBe("unchanged");
  });

  // ADR-166 (P1): the execution-host `session.command` acceptance/completion
  // line rides the same durable log. It is ledger-only — the transcript
  // projector neither renders it nor treats it as a coalescing reset.
  it("ignores a session.command line (no message, no reset)", async () => {
    const { runId, slug, planAttemptId } = await seed();

    await writeEvents(slug, runId, [textLine(planAttemptId, 1, "plan output")]);
    await projectRunTranscript(runId, { client: db });

    await writeEvents(slug, runId, [
      textLine(planAttemptId, 1, "plan output"),
      JSON.stringify({
        type: "session.command",
        monotonicId: 2,
        sessionName: "node",
        nodeAttemptId: planAttemptId,
        commandId: randomUUID(),
        kind: "session.prompt",
        phase: "completed",
        status: "succeeded",
        result: { stopReason: "end_turn" },
      }),
      textLine(planAttemptId, 3, " continued"),
    ]);

    const again = await projectRunTranscript(runId, {
      client: db,
    });

    expect(again.status).toBe("projected");

    // No reset between the two chunks: they coalesce into ONE message, and no
    // message was minted for the command line itself.
    const plan = await getRunNodeTranscript(runId, "plan", { client: db });

    expect(plan?.messages).toHaveLength(1);
    expect(plan?.messages[0]).toMatchObject({
      role: "assistant",
      content: "plan output continued",
    });
  });

  it("returns the LATEST attempt's transcript for a reworked node", async () => {
    const { runId, slug } = await seed();
    const nodeId = "review";
    const attempt1 = randomUUID();
    const attempt2 = randomUUID();

    await db.insert(schema.nodeAttempts).values([
      {
        id: attempt1,
        runId,
        nodeId,
        nodeType: "ai_coding",
        attempt: 1,
        status: "Reworked",
      },
      {
        id: attempt2,
        runId,
        nodeId,
        nodeType: "ai_coding",
        attempt: 2,
        status: "Running",
      },
    ]);

    await writeEvents(slug, runId, [
      textLine(attempt1, 1, "first attempt output"),
      textLine(attempt2, 2, "second attempt output"),
    ]);

    await projectRunTranscript(runId, { client: db });

    const transcript = await getRunNodeTranscript(runId, nodeId, {
      client: db,
    });

    expect(transcript?.messages).toHaveLength(1);
    expect(transcript?.messages[0].content).toBe("second attempt output");
  });

  it("returns missing-run for an unknown run and empty for a node with no attempt", async () => {
    const missing = await projectRunTranscript(randomUUID(), {
      client: db,
    });

    expect(missing.status).toBe("missing-run");

    const { runId } = await seed();
    const empty = await getRunNodeTranscript(runId, "never-ran", {
      client: db,
    });

    expect(empty?.messages).toEqual([]);
  });

  // Codex adversarial finding #2: cross-run attribution must not leak. A
  // canonical event carrying an impossible association is poison, not a line
  // that the projector may silently skip.
  it("fails loudly and atomically for a node attempt owned by a different run", async () => {
    const a = await seed();
    const b = await seed();

    // Run A's durable log carries a line mis-stamped with run B's attempt id.
    await writeEvents(a.slug, a.runId, [
      textLine(a.planAttemptId, 1, "legit A output"),
      textLine(b.planAttemptId, 2, "would leak into A's transcript"),
    ]);

    await expect(
      projectRunTranscript(a.runId, { client: db }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
    });

    // The transaction is atomic: even the preceding valid event did not
    // become a partial transcript and the durable cursor did not advance.
    const aRows = await db
      .select()
      .from(schema.runMessages)
      .where(eq(schema.runMessages.runId, a.runId));

    expect(aRows).toHaveLength(0);

    // The mis-attributed line created NO row for run B's attempt (insert-side
    // ownership guard), and run B's transcript stays empty.
    const bRows = await db
      .select()
      .from(schema.runMessages)
      .where(eq(schema.runMessages.nodeAttemptId, b.planAttemptId));

    expect(bRows).toHaveLength(0);

    const bPlan = await getRunNodeTranscript(b.runId, "plan", { client: db });

    expect(bPlan?.messages).toEqual([]);

    // Read-side defense-in-depth: even a hand-inserted cross-run row (run B's
    // id, run A's attempt) is excluded by getRunNodeTranscript's runId filter.
    await db.insert(schema.runMessages).values({
      id: randomUUID(),
      runId: b.runId,
      nodeAttemptId: a.planAttemptId,
      sequence: 999,
      role: "assistant",
      content: "cross-run row",
    });

    const aPlanAfter = await getRunNodeTranscript(a.runId, "plan", {
      client: db,
    });

    expect(aPlanAfter?.messages).toEqual([]);
  });

  it("replays standalone whole-run transcripts from canonical DB rows", async () => {
    const { runId, slug } = await seedStandaloneAgentRun();

    await writeEvents(slug, runId, [
      wholeRunTextLine(1, "Plan "),
      wholeRunTextLine(2, "ready"),
      wholeRunTextLine(3, "!"),
    ]);

    const feed = await getWholeRunTranscriptMessages(runId, {
      client: db,
    });

    expect(feed.messages).toHaveLength(1);
    expect(feed.messages[0]).toMatchObject({
      role: "assistant",
      content: "Plan ready!",
      supervisorEventId: "3",
    });
    expect(feed.lastEventAt).toBeInstanceOf(Date);

    const rows = await db
      .select()
      .from(schema.runMessages)
      .where(eq(schema.runMessages.runId, runId));

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      role: "assistant",
      content: "Plan ready!",
    });
  });

  // Codex adversarial finding #1: a partial/failed projection must not advance
  // the cursor and strand rows — projection is atomic, so a failure rolls back
  // and the next call repairs the full transcript.
  it("rolls back a failed projection and repairs the full transcript on the next call", async () => {
    const { runId, slug, planAttemptId, implAttemptId } = await seed();

    await writeEvents(slug, runId, [
      textLine(planAttemptId, 1, "plan output"),
      textLine(implAttemptId, 2, "impl output"),
    ]);

    // A real database trigger rejects the second attempt's message inside the
    // bounded transaction, including the first message and coalescing state.
    await testDatabase.pool.query(
      "CREATE TABLE transcript_projection_fault (attempt_id text PRIMARY KEY)",
    );
    await testDatabase.pool.query(
      "INSERT INTO transcript_projection_fault VALUES ($1)",
      [implAttemptId],
    );
    await testDatabase.pool
      .query(`CREATE FUNCTION fail_transcript_projection() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF EXISTS (SELECT 1 FROM transcript_projection_fault WHERE attempt_id = NEW.node_attempt_id) THEN
          RAISE EXCEPTION 'injected transcript projection failure' USING ERRCODE = '40001';
        END IF;
        RETURN NEW;
      END $$`);
    await testDatabase.pool
      .query(`CREATE TRIGGER fail_transcript_projection BEFORE INSERT ON run_messages
      FOR EACH ROW EXECUTE FUNCTION fail_transcript_projection()`);
    try {
      const failed = await projectRunTranscript(runId, { client: db });

      expect(failed).toMatchObject({
        status: "missing-events",
        rowsUpserted: 0,
      });
    } finally {
      await testDatabase.pool.query(
        "DROP TRIGGER fail_transcript_projection ON run_messages",
      );
      await testDatabase.pool.query(
        "DROP FUNCTION fail_transcript_projection()",
      );
      await testDatabase.pool.query("DROP TABLE transcript_projection_fault");
    }

    // The transaction rolled back — nothing committed, so the cursor (max
    // supervisor_event_id) never advanced past the missing rows.
    const afterFailure = await db
      .select()
      .from(schema.runMessages)
      .where(eq(schema.runMessages.runId, runId));

    expect(afterFailure).toHaveLength(0);

    // The durable retry is due; a subsequent quantum replays from its cursor.
    await testDatabase.pool.query(
      "UPDATE execution_event_consumers SET next_retry_at = now() WHERE run_id = $1 AND consumer_name = 'canonical-run-transcript-v2'",
      [runId],
    );
    const repaired = await projectRunTranscript(runId, {
      client: db,
    });

    expect(repaired.status).toBe("projected");

    const plan = await getRunNodeTranscript(runId, "plan", { client: db });
    const impl = await getRunNodeTranscript(runId, "implement", { client: db });

    expect(plan?.messages).toHaveLength(1);
    expect(impl?.messages).toHaveLength(1);
  });

  it("REQ-P4-04: coalesces a 100-event mixed stream in <= 15 domain SQL queries with byte-identical output to per-event replay", async () => {
    const runA = await seed();
    const runB = await seed();

    const buildStream = (attemptId: string): string[] => {
      const lines: string[] = [];
      let seq = 1;

      for (let i = 0; i < 30; i += 1) {
        lines.push(textLine(attemptId, seq++, `tok-${i} `));
      }
      for (let i = 0; i < 25; i += 1) {
        lines.push(
          JSON.stringify({
            type: "session.update",
            monotonicId: seq++,
            sessionName: "node",
            nodeAttemptId: attemptId,
            update: {
              sessionUpdate: "agent_thought_chunk",
              content: { type: "text", text: `think-${i};` },
            },
          }),
        );
      }
      for (let i = 0; i < 20; i += 1) {
        lines.push(usageLine(attemptId, seq++, 1000 + i * 100));
      }
      lines.push(
        JSON.stringify({
          type: "session.update",
          monotonicId: seq++,
          sessionName: "node",
          nodeAttemptId: attemptId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "call-batch-1",
            title: "Inspect file",
            kind: "read",
            status: "in_progress",
            rawInput: { path: "src/app.ts" },
            content: [],
          },
        }),
      );
      for (let i = 0; i < 10; i += 1) {
        lines.push(
          JSON.stringify({
            type: "session.update",
            monotonicId: seq++,
            sessionName: "node",
            nodeAttemptId: attemptId,
            update: {
              sessionUpdate: "tool_call_update",
              toolCallId: "call-batch-1",
              status: i === 9 ? "completed" : "in_progress",
              ...(i === 0 ? { rawInput: { path: "src/app.ts", line: 1 } } : {}),
              content:
                i % 2 === 0
                  ? [
                      {
                        type: "content",
                        content: { type: "text", text: `line-${i}` },
                      },
                    ]
                  : [],
            },
          }),
        );
      }
      lines.push(
        JSON.stringify({
          type: "session.command",
          monotonicId: seq++,
          nodeAttemptId: attemptId,
          kind: "session.steer",
          phase: "accepted",
        }),
      );
      for (let i = 0; i < 13; i += 1) {
        lines.push(textLine(attemptId, seq++, `after-${i} `));
      }

      return lines;
    };

    const linesA = buildStream(runA.implAttemptId);
    const linesB = buildStream(runB.implAttemptId);

    expect(linesA).toHaveLength(100);
    await writeEvents(runA.slug, runA.runId, linesA);
    await writeEvents(runB.slug, runB.runId, linesB);

    // Project runA via the canonical batch projector and count domain SQL queries.
    const domainQueries: string[] = [];
    const originalQuery = Client.prototype.query;
    const querySpy = vi
      .spyOn(Client.prototype, "query")
      .mockImplementation(function (this: Client, ...args: unknown[]) {
        const first = args[0];
        const sqlText =
          typeof first === "string"
            ? first
            : first && typeof first === "object" && "text" in first
              ? String((first as { text: unknown }).text)
              : "";
        const lower = sqlText.toLowerCase();

        if (
          lower.includes('"runs"') ||
          lower.includes('"node_attempts"') ||
          lower.includes('"run_transcript_states"') ||
          lower.includes('"run_messages"')
        ) {
          domainQueries.push(sqlText);
        }

        return (originalQuery as (...a: unknown[]) => unknown).apply(
          this,
          args,
        );
      } as typeof Client.prototype.query);

    try {
      const summary = await projectExecutionEvents({
        db: db as unknown as Parameters<typeof projectExecutionEvents>[0]["db"],
        runId: runA.runId,
        projector: canonicalTranscriptProjector,
      });

      expect(summary).toMatchObject({
        projected: 100,
        poisoned: false,
        lastRunSequence: "100",
      });
    } finally {
      querySpy.mockRestore();
    }

    // Project runB strictly event-by-event using projectTranscriptEvent as ground truth.
    const eventsB = await db
      .select()
      .from(fullSchema.executionEvents)
      .where(eq(fullSchema.executionEvents.runId, runB.runId))
      .orderBy(asc(fullSchema.executionEvents.runSequence));

    await db.transaction(async (tx) => {
      for (const event of eventsB) {
        await projectTranscriptEvent(
          tx as unknown as Parameters<typeof projectTranscriptEvent>[0],
          event,
        );
      }
    });

    expect(domainQueries.length).toBeLessThanOrEqual(15);

    const normalizeMessages = (
      rows: (typeof fullSchema.runMessages.$inferSelect)[],
    ) =>
      rows.map((r) => ({
        sequence: r.sequence,
        role: r.role,
        content:
          r.role === "assistant"
            ? r.content
            : (JSON.parse(r.content) as unknown),
        firstSupervisorEventId: r.firstSupervisorEventId,
        supervisorEventId: r.supervisorEventId,
        projectionToolKey: r.projectionToolKey,
      }));

    const msgsA = await db
      .select()
      .from(fullSchema.runMessages)
      .where(eq(fullSchema.runMessages.runId, runA.runId))
      .orderBy(asc(fullSchema.runMessages.sequence));
    const msgsB = await db
      .select()
      .from(fullSchema.runMessages)
      .where(eq(fullSchema.runMessages.runId, runB.runId))
      .orderBy(asc(fullSchema.runMessages.sequence));

    expect(normalizeMessages(msgsA)).toEqual(normalizeMessages(msgsB));

    const [stateA] = await db
      .select()
      .from(fullSchema.runTranscriptStates)
      .where(eq(fullSchema.runTranscriptStates.runId, runA.runId));
    const [stateB] = await db
      .select()
      .from(fullSchema.runTranscriptStates)
      .where(eq(fullSchema.runTranscriptStates.runId, runB.runId));

    expect({
      nextSequence: stateA?.nextSequence,
      openTextSequence: stateA?.openTextSequence,
      openThoughtSequence: stateA?.openThoughtSequence,
      usageSequence: stateA?.usageSequence,
    }).toEqual({
      nextSequence: stateB?.nextSequence,
      openTextSequence: stateB?.openTextSequence,
      openThoughtSequence: stateB?.openThoughtSequence,
      usageSequence: stateB?.usageSequence,
    });
  });

  it("REQ-P4-05: rolls back coalesced savepoint and poisons exact failing event #37 on unstorable payload", async () => {
    const { runId, slug, implAttemptId } = await seed();
    const lines = Array.from({ length: 50 }, (_, i) =>
      textLine(implAttemptId, i + 1, `chunk-${i + 1} `),
    );

    await writeEvents(slug, runId, lines);

    const [event37] = await db
      .select({ id: fullSchema.executionEvents.id })
      .from(fullSchema.executionEvents)
      .where(
        and(
          eq(fullSchema.executionEvents.runId, runId),
          eq(fullSchema.executionEvents.runSequence, 37n),
        ),
      );

    expect(event37).toBeDefined();

    const summary = await projectExecutionEvents({
      db: db as unknown as Parameters<typeof projectExecutionEvents>[0]["db"],
      runId,
      projector: {
        ...canonicalTranscriptProjector,
        prepare: async (_db, event) =>
          event.runSequence === 37n
            ? {
                ...event,
                payload: {
                  ...event.payload,
                  update: {
                    sessionUpdate: "agent_message_chunk",
                    content: { type: "text", text: "poison-\u0000-37" },
                  },
                },
              }
            : event,
      },
    });

    expect(summary.poisoned).toBe(true);

    const [consumer] = await db
      .select({
        state: fullSchema.executionEventConsumers.state,
        poisonEventId: fullSchema.executionEventConsumers.poisonEventId,
      })
      .from(fullSchema.executionEventConsumers)
      .where(
        and(
          eq(fullSchema.executionEventConsumers.runId, runId),
          eq(
            fullSchema.executionEventConsumers.consumerName,
            canonicalTranscriptProjector.consumerName,
          ),
        ),
      );

    expect(consumer).toEqual({
      state: "poisoned",
      poisonEventId: event37!.id,
    });

    const committed = await db
      .select()
      .from(fullSchema.runMessages)
      .where(eq(fullSchema.runMessages.runId, runId));

    expect(committed).toHaveLength(0);
  });
});
