import type { Db } from "@/lib/execution-host/db";

import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { beforeAll, afterAll, describe, expect, it } from "vitest";

import {
  runs,
  agentTurns,
  runSessions,
  runSessionIncarnations,
  executionHosts,
  executionCommands,
} from "@/lib/db/schema";
import { acceptAgentMessage } from "@/lib/agents/turns";
import { mintAssignment } from "@/lib/execution-host/assignments";
import { issueOwnedPrompt } from "@/lib/execution-host/ledger";
import { seedLocalHost } from "@/test-support/execution-host-seed";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

let database: StartedPostgresTestDb;
let db: Db;

beforeAll(async () => {
  database = await startMainPostgresTestDb({
    databaseName: "agent_turn_admission",
  });
  db = database.db as unknown as Db;
}, 180_000);

afterAll(async () => {
  await database?.stop();
});

async function seedRun(): Promise<string> {
  const runId = randomUUID();

  await db.insert(runs).values({
    id: runId,
    runKind: "agent",
    flowVersion: "agent",
    flowRevision: "manual",
    status: "NeedsInputIdle",
    persistent: true,
  });

  return runId;
}

describe("Durable agent turn admission", () => {
  it("binds one turn to its exact command and preserves the run cascade", async () => {
    const runId = await seedRun();
    const first = await acceptAgentMessage(db, runId, "first input");
    const next = await acceptAgentMessage(db, runId, "next input");
    const hostId = (await seedLocalHost(database.db)).id;
    const assignment = await db.transaction((tx) =>
      mintAssignment(tx, { runId, hostId, reason: "resume" }),
    );
    const sessionId = randomUUID();
    const incarnationId = randomUUID();
    const targetSessionId = randomUUID();

    await db.insert(runSessions).values({
      id: sessionId,
      runId,
      sessionName: "default",
      executionAssignmentId: assignment.id,
      hostSessionId: targetSessionId,
    });
    await db.insert(runSessionIncarnations).values({
      id: incarnationId,
      runId,
      runSessionId: sessionId,
      executionAssignmentId: assignment.id,
      assignmentEpoch: assignment.epoch,
      executionHostId: hostId,
      hostSessionId: targetSessionId,
      state: "active",
      origin: "native",
    });
    await db.update(runs).set({ status: "Running" }).where(eq(runs.id, runId));
    const binding = {
      state: "claimed" as const,
      executionAssignmentId: assignment.id,
      assignmentEpoch: assignment.epoch,
      runSessionId: sessionId,
    };

    await db.update(agentTurns).set(binding).where(eq(agentTurns.id, first.id));
    await expect(
      db.update(agentTurns).set(binding).where(eq(agentTurns.id, next.id)),
    ).rejects.toMatchObject({
      code: "23505",
      constraint: "agent_turns_active_run_uq",
    });
    await expect(
      db
        .update(agentTurns)
        .set({ assignmentEpoch: assignment.epoch + 1 })
        .where(eq(agentTurns.id, first.id)),
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "agent_turns_binding_immutable",
    });
    const [host] = await db
      .select()
      .from(executionHosts)
      .where(eq(executionHosts.id, hostId));
    const operationKey = `agent_turn:persistent_message:${first.id}:${first.ordinal}`;
    const command = await issueOwnedPrompt(db, {
      assignment,
      host,
      targetSessionId,
      payload: { stepId: "agent", prompt: first.prompt },
      maxAttempts: 3,
      admitOwner: async (tx) => {
        await tx.select().from(runs).where(eq(runs.id, runId)).for("update");

        return {
          owner: {
            kind: "agent_turn",
            ref: {
              version: 1,
              variant: "persistent_message",
              messageId: first.id,
              turnId: first.id,
              promptOrdinal: first.ordinal,
              runId,
              assignmentId: assignment.id,
              assignmentEpoch: assignment.epoch,
              runSessionId: sessionId,
              incarnationId,
            },
          },
          logicalOperationKey: operationKey,
          assertCommit: async () => {
            const [admitted] = await tx
              .select()
              .from(executionCommands)
              .where(eq(executionCommands.logicalOperationKey, operationKey));

            await tx
              .update(agentTurns)
              .set({
                state: "dispatched",
                commandId: admitted.id,
                incarnationId,
              })
              .where(eq(agentTurns.id, first.id));
          },
        };
      },
    });
    const [stored] = await db
      .select()
      .from(agentTurns)
      .where(eq(agentTurns.id, first.id));

    expect(stored).toMatchObject({
      state: "dispatched",
      commandId: command.row.id,
      incarnationId,
    });
    await expect(
      db
        .update(agentTurns)
        .set({
          state: "queued",
          executionAssignmentId: null,
          assignmentEpoch: null,
          runSessionId: null,
          incarnationId: null,
          commandId: null,
        })
        .where(eq(agentTurns.id, first.id)),
    ).rejects.toMatchObject({ code: "23514" });
    await db.delete(runs).where(eq(runs.id, runId));
    expect(
      await db.select().from(agentTurns).where(eq(agentTurns.runId, runId)),
    ).toHaveLength(0);
  });

  it("concurrent retries retain one original input before capacity admission", async () => {
    const runId = await seedRun();
    const accepted = await Promise.all(
      Array.from({ length: 6 }, () =>
        acceptAgentMessage(db, runId, "original message", {
          requestKey: "same-request",
        }),
      ),
    );

    expect(new Set(accepted.map((turn) => turn.id)).size).toBe(1);
    expect(accepted[0]).toMatchObject({
      ordinal: 1,
      state: "queued",
      variant: "persistent_message",
      executionAssignmentId: null,
      commandId: null,
    });
    const [run] = await db.select().from(runs).where(eq(runs.id, runId));

    expect(run.status).toBe("NeedsInputIdle");
    expect(
      await db.select().from(agentTurns).where(eq(agentTurns.runId, runId)),
    ).toHaveLength(1);
    await expect(
      acceptAgentMessage(db, runId, "replacement", {
        requestKey: "same-request",
      }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      details: { reason: "agent_turn_request_conflict" },
    });
  });

  it("distinct messages keep distinct ordered input and keys are scoped to a run", async () => {
    const runId = await seedRun();
    const otherRunId = await seedRun();
    const accepted = await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        acceptAgentMessage(db, runId, `message ${index}`, {
          requestKey: `request-${index}`,
        }),
      ),
    );

    expect(new Set(accepted.map((turn) => turn.id)).size).toBe(4);
    expect(accepted.map((turn) => turn.ordinal).sort()).toEqual([1, 2, 3, 4]);
    const other = await acceptAgentMessage(db, otherRunId, "other input", {
      requestKey: "request-0",
    });

    expect(other.ordinal).toBe(1);
    expect(accepted.map((turn) => turn.id)).not.toContain(other.id);
  });

  it("refuses new input after termination and preserves a previous acknowledgment", async () => {
    const runId = await seedRun();
    const original = await acceptAgentMessage(db, runId, "accepted input", {
      requestKey: "accepted",
    });

    await db
      .update(runs)
      .set({ status: "Abandoned" })
      .where(eq(runs.id, runId));
    const repeated = await acceptAgentMessage(db, runId, "accepted input", {
      requestKey: "accepted",
    });

    expect(repeated.id).toBe(original.id);
    await expect(
      acceptAgentMessage(db, runId, "new input"),
    ).rejects.toMatchObject({ code: "PRECONDITION" });
    expect(
      await db.select().from(agentTurns).where(eq(agentTurns.runId, runId)),
    ).toHaveLength(1);
  });

  it("persists queued input and rejects rewriting its original source", async () => {
    const runId = await seedRun();
    const turnId = randomUUID();

    await database.pool.query(
      "INSERT INTO agent_turns (id, run_id, ordinal, variant, logical_key, prompt) VALUES ($1, $2, 0, 'persistent_message', 'message:original', 'original input')",
      [turnId, runId],
    );
    const stored = await database.pool.query<{ prompt: string; state: string }>(
      "SELECT prompt, state FROM agent_turns WHERE id = $1",
      [turnId],
    );

    expect(stored.rows).toEqual([
      { prompt: "original input", state: "queued" },
    ]);
    await expect(
      database.pool.query(
        "UPDATE agent_turns SET prompt = 'replacement input' WHERE id = $1",
        [turnId],
      ),
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "agent_turns_source_immutable",
    });
    await expect(
      database.pool.query(
        "UPDATE agent_turns SET state = 'applied' WHERE id = $1",
        [turnId],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });
});
