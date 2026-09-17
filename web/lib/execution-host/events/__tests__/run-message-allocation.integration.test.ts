// TRC-06 / TRC-10 + EDGE-TRC-03/06: `run_messages` gains a SECOND writer.
//
// Until now the transcript projector was the only thing that allocated a
// `run_messages.sequence`, so "read `next_sequence`, insert, bump" was safe by
// being alone. Recording dispatched prompts adds a writer on the same scope,
// and `run_messages_run_node_attempt_sequence_uq` turns any interleaving into a
// hard unique violation — on the paid dispatch path.
//
// Two separate guarantees are pinned here. Allocation is serialized on ONE
// per-scope lock (TRC-10), and duplicate-dispatch suppression is a DATABASE
// constraint rather than application ordering (TRC-06) — a retry from another
// process, or a defect in the lock logic, must still not double-write.

import { randomUUID } from "node:crypto";

import { and, eq, isNull } from "drizzle-orm";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as fullSchema from "@/lib/db/schema";
import { appendRunMessage } from "@/lib/execution-host/events/run-message-store";
import { projectTranscriptEvent } from "@/lib/execution-host/events/transcript-projector";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const schema = fullSchema as unknown as Record<string, any>;

let testDatabase: StartedPostgresTestDb;
let db: NodePgDatabase;

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "run_message_allocation_test",
  });
  db = testDatabase.db;
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

type Seeded = { runId: string; nodeAttemptId: string };

async function seedRun(): Promise<Seeded> {
  const projectId = randomUUID();
  const runId = randomUUID();
  const nodeAttemptId = randomUUID();
  const slug = `alloc-${projectId.slice(0, 8)}`;

  await db.insert(schema.projects).values({
    id: projectId,
    taskKey: `T${projectId.slice(0, 8)}`.toUpperCase(),
    slug,
    name: slug,
    repoPath: `/tmp/${slug}`,
    maisterYamlPath: `/tmp/${slug}/maister.yaml`,
  });
  await db.insert(schema.runs).values({
    id: runId,
    projectId,
    runKind: "flow",
    status: "Running",
    executionDataPlaneMode: "canonical_events_v1",
    flowVersion: "v1",
    flowRevision: "test",
  });
  await db.insert(schema.nodeAttempts).values({
    id: nodeAttemptId,
    runId,
    nodeId: "implement",
    nodeType: "ai_coding",
    attempt: 1,
    status: "Running",
  });

  return { runId, nodeAttemptId };
}

function chunkEvent(seeded: Seeded, runSequence: bigint) {
  return {
    id: randomUUID(),
    source: "host",
    runId: seeded.runId,
    eventType: "session.update",
    payloadSchema: "maister.session.update.v1",
    payload: {
      nodeAttemptId: seeded.nodeAttemptId,
      update: { sessionUpdate: "agent_message_chunk", content: { text: "hi" } },
    },
    runSequence,
    ingestDisposition: "accepted",
  } as never;
}

// A `tool_call` ALWAYS allocates a fresh sequence. A text chunk does not: with
// an open text row the projector coalesces into it via `replace`, allocating
// nothing — which is exactly how an earlier version of IT-TRC-10 managed to
// "race" without ever opening the allocator window.
function toolCallEvent(seeded: Seeded, runSequence: bigint) {
  return {
    id: randomUUID(),
    source: "host",
    runId: seeded.runId,
    eventType: "session.update",
    payloadSchema: "maister.session.update.v1",
    payload: {
      nodeAttemptId: seeded.nodeAttemptId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: `tool-${runSequence.toString()}`,
        title: "Run check",
        status: "completed",
      },
    },
    runSequence,
    ingestDisposition: "accepted",
  } as never;
}

async function messagesFor(seeded: Seeded) {
  return db
    .select()
    .from(schema.runMessages)
    .where(eq(schema.runMessages.runId, seeded.runId));
}

describe("run_messages allocation", () => {
  // IT-TRC-10. Without a shared lock both writers read the same
  // `next_sequence` and the second insert dies on the unique key.
  //
  // The scope's state row MUST already exist before the race, and that is the
  // whole difficulty of this test. On a fresh scope both writers contend on
  // `INSERT ... ON CONFLICT DO NOTHING` into `run_transcript_states`, and that
  // insert is itself a serialization point — the loser blocks on the unique
  // index until the winner's transaction commits, so the allocator window
  // never opens. An earlier version of this test raced on fresh scopes and
  // passed 3/3 against the UNFIXED allocator: it proved nothing
  // (memory:falsify-every-regression-guard). Seeding the row first reproduces
  // the real production shape — the projector created it, a prompt arrives —
  // and fails reliably without the lock.
  //
  // The loop is deliberate for the same reason: a guard that reproduces its
  // own bug one run in twenty is not a guard.
  it("IT-TRC-10: serializes a prompt write against a concurrent projected chunk", async () => {
    const ROUNDS = 12;

    for (let round = 0; round < ROUNDS; round += 1) {
      const seeded = await seedRun();

      // Establish the scope: after this the allocator row exists and its
      // creation can no longer serialize the two writers below.
      await db.transaction(async (tx) =>
        projectTranscriptEvent(tx as never, toolCallEvent(seeded, 0n)),
      );

      const event = toolCallEvent(seeded, BigInt(round + 1));
      const [, projected] = await Promise.all([
        db.transaction(async (tx) =>
          appendRunMessage(tx as never, {
            runId: seeded.runId,
            nodeAttemptId: seeded.nodeAttemptId,
            role: "user",
            content: `prompt ${round}`,
            promptDispatchKey: `dispatch:${seeded.nodeAttemptId}:0`,
          }),
        ),
        db.transaction(async (tx) =>
          projectTranscriptEvent(tx as never, event),
        ),
      ]);

      expect(projected).toBe(true);

      const rows = await messagesFor(seeded);
      const sequences = rows.map((row) => row.sequence as number);

      // Seed tool row + racing tool row + prompt row, each at its own sequence.
      expect(rows).toHaveLength(3);
      expect(new Set(sequences).size).toBe(3);
    }
  }, 180_000);

  // IT-TRC-06. The guarantee is a CONSTRAINT, not ordering: a redelivered
  // dispatch writes nothing extra even when the two writes never overlap.
  it("IT-TRC-06: records one row for a repeated dispatch key", async () => {
    const seeded = await seedRun();
    const key = `dispatch:${seeded.nodeAttemptId}:0`;
    const write = () =>
      db.transaction(async (tx) =>
        appendRunMessage(tx as never, {
          runId: seeded.runId,
          nodeAttemptId: seeded.nodeAttemptId,
          role: "user",
          content: "implement the widget",
          promptDispatchKey: key,
        }),
      );

    const first = await write();
    const second = await write();

    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);
    await expect(messagesFor(seeded)).resolves.toHaveLength(1);
  }, 60_000);

  // IT-EDGE-TRC-06. The losing insert of a genuinely concurrent duplicate is a
  // NO-OP, never an error the caller sees: the write is best-effort (TRC-08),
  // and a redelivery must not surface as a failure on the dispatch path.
  it("IT-EDGE-TRC-06: a concurrent duplicate dispatch writes exactly one row without raising", async () => {
    const seeded = await seedRun();
    const key = `dispatch:${seeded.nodeAttemptId}:0`;
    const write = () =>
      db.transaction(async (tx) =>
        appendRunMessage(tx as never, {
          runId: seeded.runId,
          nodeAttemptId: seeded.nodeAttemptId,
          role: "user",
          content: "implement the widget",
          promptDispatchKey: key,
        }),
      );

    const results = await Promise.all([write(), write()]);

    expect(results.filter((result) => result.inserted)).toHaveLength(1);
    await expect(messagesFor(seeded)).resolves.toHaveLength(1);
  }, 60_000);

  // IT-EDGE-TRC-03. Postgres treats NULLs as distinct in a unique key by
  // default, which would silently disable BOTH the sequence key and the
  // dispatch-key constraint for a row whose `node_attempt_id` is NULL — so the
  // new index must match the existing one's `nulls not distinct`.
  //
  // This calls `appendRunMessage` DIRECTLY and deliberately: no production
  // writer produces this row today. The only recorder is the flow dispatcher
  // and it always names an attempt, so there is no producer to drive here.
  // That makes this a FORWARD contract on the constraint rather than coverage
  // of a live path — it is what stops the null-attempt case from being a
  // silent hole if a second recorder (a standalone agent turn) is ever wired.
  it("IT-EDGE-TRC-03: keeps both unique keys effective when node_attempt_id is null", async () => {
    const seeded = await seedRun();
    const key = `dispatch:agent:${seeded.runId}:0`;
    const write = () =>
      db.transaction(async (tx) =>
        appendRunMessage(tx as never, {
          runId: seeded.runId,
          nodeAttemptId: null,
          role: "user",
          content: "agent turn",
          promptDispatchKey: key,
        }),
      );

    const first = await write();
    const second = await write();

    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);

    const rows = await db
      .select()
      .from(schema.runMessages)
      .where(
        and(
          eq(schema.runMessages.runId, seeded.runId),
          isNull(schema.runMessages.nodeAttemptId),
        ),
      );

    expect(rows).toHaveLength(1);
  }, 60_000);

  // The projector's own inserts leave the column NULL and must stay entirely
  // outside the new partial index — otherwise a second untagged transcript row
  // on the same scope would collide.
  it("IT-TRC-06: leaves projector rows unconstrained by the dispatch key", async () => {
    const seeded = await seedRun();

    await db.transaction(async (tx) =>
      projectTranscriptEvent(tx as never, chunkEvent(seeded, 0n)),
    );
    await db.transaction(async (tx) =>
      appendRunMessage(tx as never, {
        runId: seeded.runId,
        nodeAttemptId: seeded.nodeAttemptId,
        role: "system",
        content: "no dispatch key",
      }),
    );
    await db.transaction(async (tx) =>
      appendRunMessage(tx as never, {
        runId: seeded.runId,
        nodeAttemptId: seeded.nodeAttemptId,
        role: "system",
        content: "also no dispatch key",
      }),
    );

    await expect(messagesFor(seeded)).resolves.toHaveLength(3);
  }, 60_000);
});
