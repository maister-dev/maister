import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as fullSchema from "@/lib/db/schema";
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
    const { type, monotonicId: _id, sessionName: _sessionName, ...payload } = parsed;
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
      expect.objectContaining({ role: "assistant", content: "canonical event" }),
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

    await expect(projectRunTranscript(a.runId, { client: db })).rejects.toMatchObject({
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

    const aPlanAfter = await getRunNodeTranscript(a.runId, "plan", { client: db });

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
    expect(rows[0]).toMatchObject({ role: "assistant", content: "Plan ready!" });
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

    // Inject a failure on the 2nd insert INSIDE the projection transaction.
    await expect(
      projectRunTranscript(runId, {
        client: clientFailingOnNthInsert(db, 2),
      }),
    ).rejects.toThrow();

    // The transaction rolled back — nothing committed, so the cursor (max
    // supervisor_event_id) never advanced past the missing rows.
    const afterFailure = await db
      .select()
      .from(schema.runMessages)
      .where(eq(schema.runMessages.runId, runId));

    expect(afterFailure).toHaveLength(0);

    // A clean re-projection derives and commits the FULL transcript.
    const repaired = await projectRunTranscript(runId, {
      client: db,
    });

    expect(repaired.status).toBe("projected");

    const plan = await getRunNodeTranscript(runId, "plan", { client: db });
    const impl = await getRunNodeTranscript(runId, "implement", { client: db });

    expect(plan?.messages).toHaveLength(1);
    expect(impl?.messages).toHaveLength(1);
  });
});

// Wraps the real client so the Nth `insert` issued inside a `transaction`
// throws — simulating a mid-batch DB/timeout failure to prove atomic rollback.
function clientFailingOnNthInsert(real: Db, failOnNth: number): Db {
  let inserts = 0;
  const bound = (target: any, prop: PropertyKey) => {
    const value = target[prop];

    return typeof value === "function" ? value.bind(target) : value;
  };

  return new Proxy(real as unknown as Record<PropertyKey, unknown>, {
    get(target, prop) {
      if (prop !== "transaction") return bound(target, prop);

      return (cb: (tx: unknown) => unknown, ...rest: unknown[]) =>
        (target as any).transaction(
          (tx: any) => {
            const txProxy = new Proxy(tx, {
              get(t, p) {
                if (p !== "insert") return bound(t, p);

                return (...args: unknown[]) => {
                  inserts += 1;
                  if (inserts >= failOnNth) {
                    throw new Error("injected projection failure");
                  }

                  return t.insert(...args);
                };
              },
            });

            return cb(txProxy);
          },
          ...rest,
        );
    },
  }) as unknown as Db;
}
