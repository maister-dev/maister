import type { Db } from "@/lib/execution-host/db";
import type { ExecutionHost } from "@/lib/db/schema";

import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  agentTurns,
  executionCommands,
  executionHosts,
  runs,
  runSessionIncarnations,
  runSessions,
} from "@/lib/db/schema";
import { acceptAgentMessage } from "@/lib/agents/turns";
import { mintAssignment } from "@/lib/execution-host/assignments";
import { issueCommand, issueOwnedPrompt } from "@/lib/execution-host/ledger";
import { seedLocalHost } from "@/test-support/execution-host-seed";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

// ADR-182 migration 0180 (T2.0): the constraints that let a dispatched steer sit
// beside its dispatched parent, bind an owner-less `session.steer`, and keep a
// scratch row's delivery state on the transcript row itself.

let database: StartedPostgresTestDb;
let db: Db;
let host: ExecutionHost;

beforeAll(async () => {
  database = await startMainPostgresTestDb({
    databaseName: "agent_turn_steering_migration",
  });
  db = database.db as unknown as Db;
  const hostId = (await seedLocalHost(database.db)).id;

  [host] = await db
    .select()
    .from(executionHosts)
    .where(eq(executionHosts.id, hostId));
}, 180_000);

afterAll(async () => {
  await database?.stop();
});

type Parent = {
  runId: string;
  assignment: Awaited<ReturnType<typeof mintAssignment>>;
  sessionId: string;
  incarnationId: string;
  targetSessionId: string;
  parentTurnId: string;
  parentCommandId: string;
};

// The parent is bound through the production issue path, never by hand.
async function seedDispatchedParent(): Promise<Parent> {
  const runId = randomUUID();

  await db.insert(runs).values({
    id: runId,
    runKind: "agent",
    flowVersion: "agent",
    flowRevision: "manual",
    status: "Running",
    persistent: true,
  });
  const parent = await acceptAgentMessage(db, runId, "parent input");
  const assignment = await db.transaction((tx) =>
    mintAssignment(tx, { runId, hostId: host.id, reason: "resume" }),
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
    executionHostId: host.id,
    hostSessionId: targetSessionId,
    state: "active",
    origin: "native",
    steeringSupported: true,
  });
  await db
    .update(agentTurns)
    .set({
      state: "claimed",
      executionAssignmentId: assignment.id,
      assignmentEpoch: assignment.epoch,
      runSessionId: sessionId,
    })
    .where(eq(agentTurns.id, parent.id));
  const operationKey = `agent_turn:${parent.variant}:${parent.id}:${parent.ordinal}`;
  const command = await issueOwnedPrompt(db, {
    assignment,
    host,
    targetSessionId,
    payload: { stepId: "agent", prompt: parent.prompt },
    maxAttempts: 3,
    admitOwner: async (tx) => {
      await tx.select().from(runs).where(eq(runs.id, runId)).for("update");

      return {
        owner: {
          kind: "agent_turn",
          ref: {
            version: 1,
            variant: parent.variant as "persistent_message",
            messageId: parent.id,
            turnId: parent.id,
            promptOrdinal: parent.ordinal,
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
            .where(eq(agentTurns.id, parent.id));
        },
      };
    },
  });

  return {
    runId,
    assignment,
    sessionId,
    incarnationId,
    targetSessionId,
    parentTurnId: parent.id,
    parentCommandId: command.row.id,
  };
}

async function issueSteer(parent: Parent): Promise<string> {
  const issued = await issueCommand(db, {
    assignment: parent.assignment,
    host,
    kind: "session.steer",
    targetSessionId: parent.targetSessionId,
    payload: {
      contentBlocks: [{ type: "text", text: "also X" }],
      parentCommandId: parent.parentCommandId,
    },
    maxAttempts: 3,
  });

  return issued.row.id;
}

function steerRow(parent: Parent, commandId: string, ordinal = 2) {
  return {
    id: randomUUID(),
    runId: parent.runId,
    ordinal,
    variant: "steer" as const,
    logicalKey: `message:request:${randomUUID()}`,
    prompt: "also X",
    parentTurnId: parent.parentTurnId,
    state: "dispatched" as const,
    executionAssignmentId: parent.assignment.id,
    assignmentEpoch: parent.assignment.epoch,
    runSessionId: parent.sessionId,
    incarnationId: parent.incarnationId,
    commandId,
  };
}

describe("migration 0180 agent turn steering (ADR-182)", () => {
  it("admits a dispatched steer beside its dispatched parent and keeps one owned active turn", async () => {
    const parent = await seedDispatchedParent();
    const commandId = await issueSteer(parent);
    const steer = steerRow(parent, commandId);

    await db.insert(agentTurns).values(steer);
    const [stored] = await db
      .select()
      .from(agentTurns)
      .where(eq(agentTurns.id, steer.id));

    expect(stored).toMatchObject({
      variant: "steer",
      state: "dispatched",
      parentTurnId: parent.parentTurnId,
      commandId,
    });

    const second = await acceptAgentMessage(db, parent.runId, "later input");

    await expect(
      db
        .update(agentTurns)
        .set({
          state: "claimed",
          executionAssignmentId: parent.assignment.id,
          assignmentEpoch: parent.assignment.epoch,
          runSessionId: parent.sessionId,
        })
        .where(eq(agentTurns.id, second.id)),
    ).rejects.toMatchObject({
      code: "23505",
      constraint: "agent_turns_active_run_uq",
    });

    await db
      .update(agentTurns)
      .set({ state: "applied", completedAt: new Date() })
      .where(eq(agentTurns.id, steer.id));
  });

  it("requires a parent exactly for the steer variant, in the same run", async () => {
    const parent = await seedDispatchedParent();
    const commandId = await issueSteer(parent);

    await expect(
      db
        .insert(agentTurns)
        .values({ ...steerRow(parent, commandId), parentTurnId: null }),
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "agent_turns_steer_parent_check",
    });
    await expect(
      db.insert(agentTurns).values({
        id: randomUUID(),
        runId: parent.runId,
        ordinal: 7,
        variant: "live_message",
        logicalKey: `message:${randomUUID()}`,
        prompt: "x",
        parentTurnId: parent.parentTurnId,
      }),
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "agent_turns_steer_parent_check",
    });

    const other = await seedDispatchedParent();

    await expect(
      db.insert(agentTurns).values({
        ...steerRow(parent, commandId),
        parentTurnId: other.parentTurnId,
      }),
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "agent_turns_steer_parent_scope",
    });
  });

  it("binds a steer only to an owner-less session.steer on the parent incarnation", async () => {
    const parent = await seedDispatchedParent();

    await expect(
      db.insert(agentTurns).values(steerRow(parent, parent.parentCommandId, 3)),
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "agent_turns_command_scope",
    });

    const steerCommand = await issueSteer(parent);

    await expect(
      db.insert(agentTurns).values({
        ...steerRow(parent, steerCommand, 4),
        variant: "live_message",
        parentTurnId: null,
      }),
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "agent_turns_command_scope",
    });
  });

  it("keeps delivery on user rows only and one row per steer command", async () => {
    const parent = await seedDispatchedParent();
    const commandId = await issueSteer(parent);
    const insert = (values: {
      role: string;
      sequence: number;
      delivery: string | null;
      steerCommandId: string | null;
    }) =>
      database.pool.query(
        "INSERT INTO run_messages (id, run_id, sequence, role, content, delivery, steer_command_id) VALUES ($1, $2, $3, $4, 'x', $5, $6)",
        [
          randomUUID(),
          parent.runId,
          values.sequence,
          values.role,
          values.delivery,
          values.steerCommandId,
        ],
      );

    await insert({
      role: "user",
      sequence: 1,
      delivery: "steered",
      steerCommandId: commandId,
    });
    await insert({
      role: "user",
      sequence: 2,
      delivery: "queued",
      steerCommandId: null,
    });
    await expect(
      insert({
        role: "assistant",
        sequence: 3,
        delivery: "queued",
        steerCommandId: null,
      }),
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "run_messages_delivery_check",
    });
    await expect(
      insert({
        role: "user",
        sequence: 4,
        delivery: "bogus",
        steerCommandId: null,
      }),
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "run_messages_delivery_check",
    });
    await expect(
      insert({
        role: "user",
        sequence: 5,
        delivery: "steered",
        steerCommandId: commandId,
      }),
    ).rejects.toMatchObject({
      code: "23505",
      constraint: "run_messages_steer_command_uq",
    });
  });

  it("cascades a run delete through retired steer evidence", async () => {
    const parent = await seedDispatchedParent();
    const commandId = await issueSteer(parent);

    await db.insert(agentTurns).values(steerRow(parent, commandId));
    await database.pool.query(
      "INSERT INTO run_messages (id, run_id, sequence, role, content, delivery, steer_command_id) VALUES ($1, $2, 1, 'user', 'also X', 'steered', $3)",
      [randomUUID(), parent.runId, commandId],
    );
    await db
      .update(executionCommands)
      .set({ retiredAt: new Date() })
      .where(eq(executionCommands.runId, parent.runId));
    await db.delete(runs).where(eq(runs.id, parent.runId));

    expect(
      await db
        .select()
        .from(agentTurns)
        .where(eq(agentTurns.runId, parent.runId)),
    ).toHaveLength(0);
  });

  it("records the incarnation's steering capability as a nullable fact", async () => {
    const columns = await database.pool.query<{
      is_nullable: string;
      data_type: string;
    }>(
      "SELECT is_nullable, data_type FROM information_schema.columns WHERE table_name = 'run_session_incarnations' AND column_name = 'steering_supported'",
    );

    expect(columns.rows).toEqual([
      { is_nullable: "YES", data_type: "boolean" },
    ]);
  });
});
