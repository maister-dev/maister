import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { BoundClient, PreparedSteer } from "@/lib/execution-host/client";
import type { AgentTurn } from "@/lib/db/schema";

import { randomUUID } from "node:crypto";

import { and, eq, inArray, sql } from "drizzle-orm";
import pino from "pino";

import { OWNED_TURN_VARIANTS } from "./turn-variants";
import {
  assertAcceptsAgentMessage,
  insertAgentMessageTurn,
  lockPersistentAgentRun,
  messageLogicalKey,
  sameKeyMessage,
} from "./turns";

import {
  agentTurns,
  executionAssignments,
  executionCommands,
  runSessionIncarnations,
} from "@/lib/db/schema";
import { appendRunMessage } from "@/lib/execution-host/events/run-message-store";
import { steerRequeueKey } from "@/lib/execution-host/steer-settlement";
import { boundPromptBody, eventHorizon } from "@/lib/flows/graph/prompt-record";

const log = pino({
  name: "agent-steering",
  level: process.env.LOG_LEVEL ?? "info",
});

export type AgentSteerAcceptance =
  | Readonly<{
      kind: "issued";
      steerTurn: AgentTurn;
      prepared: PreparedSteer;
    }>
  // Not steerable now: accepted as an ordinary queued message instead.
  | Readonly<{
      kind: "queued";
      turn: AgentTurn;
      reason: "no_active_turn" | "unsupported" | "unbound";
    }>
  // A same-key retry: the row that key already identifies, untouched.
  | Readonly<{ kind: "existing"; turn: AgentTurn }>;

export function steerTranscriptKey(commandId: string): string {
  return `steer:${commandId}`;
}

/**
 * ADR-182 D-C3/D-C4. Accept a message as a steer when the run's owned turn is
 * running on a session that advertised steering, else as an ordinary queued
 * message — decided in ONE transaction under the run lock, then the parent
 * turn's lock, so the parent cannot settle between the decision and the
 * intent. The steer row, its `session.steer` ledger row (queued before the
 * wire) and the operator-visible transcript row commit together; the caller
 * delivers after commit.
 */
export async function acceptAgentSteer(
  db: Db,
  client: BoundClient | null,
  runId: string,
  prompt: string,
  options: Readonly<{ requestKey?: string }> = {},
): Promise<AgentSteerAcceptance> {
  const logicalKey = messageLogicalKey(options.requestKey);

  return db.transaction(async (tx): Promise<AgentSteerAcceptance> => {
    const txDb = tx as unknown as Db;
    const run = await lockPersistentAgentRun(txDb, runId);
    const existing = await sameKeyMessage(txDb, run.id, logicalKey, prompt);

    if (existing) return { kind: "existing", turn: existing };
    assertAcceptsAgentMessage(run);
    const queue = async (
      reason: "no_active_turn" | "unsupported" | "unbound",
    ): Promise<AgentSteerAcceptance> => {
      const turn = await insertAgentMessageTurn(txDb, run, prompt, logicalKey);

      log.info(
        { runId, turnId: turn.id, ordinal: turn.ordinal, reason },
        "agent-steer-queued",
      );

      return { kind: "queued", turn, reason };
    };
    const [parent] = await tx
      .select()
      .from(agentTurns)
      .where(
        and(
          eq(agentTurns.runId, run.id),
          eq(agentTurns.state, "dispatched"),
          inArray(agentTurns.variant, [...OWNED_TURN_VARIANTS]),
        ),
      )
      .for("update");

    if (
      !parent?.commandId ||
      !parent.incarnationId ||
      !parent.executionAssignmentId ||
      parent.executionAssignmentId !== run.executionAssignmentId
    )
      return queue("no_active_turn");
    if (!client || client.assignment.id !== parent.executionAssignmentId)
      return queue("unbound");
    const [assignment] = await tx
      .select({ state: executionAssignments.state })
      .from(executionAssignments)
      .where(eq(executionAssignments.id, parent.executionAssignmentId));
    const [command] = await tx
      .select()
      .from(executionCommands)
      .where(eq(executionCommands.id, parent.commandId));
    const [incarnation] = await tx
      .select()
      .from(runSessionIncarnations)
      .where(eq(runSessionIncarnations.id, parent.incarnationId));

    if (
      assignment?.state !== "active" ||
      command?.kind !== "session.prompt" ||
      command.state !== "accepted" ||
      command.executionAssignmentId !== parent.executionAssignmentId ||
      !command.targetSessionId
    )
      return queue("no_active_turn");
    if (incarnation?.steeringSupported !== true) return queue("unsupported");

    const prepared = await client.prepareSteer(txDb, command.targetSessionId, {
      contentBlocks: [{ type: "text", text: prompt }],
      parentCommandId: command.id,
    });
    const [sequence] = await tx
      .select({
        ordinal: sql<number>`coalesce(max(${agentTurns.ordinal}), 0) + 1`,
      })
      .from(agentTurns)
      .where(eq(agentTurns.runId, run.id));
    const [steerTurn] = await tx
      .insert(agentTurns)
      .values({
        id: randomUUID(),
        runId: run.id,
        ordinal: sequence.ordinal,
        variant: "steer",
        logicalKey,
        prompt,
        parentTurnId: parent.id,
        state: "dispatched",
        executionAssignmentId: parent.executionAssignmentId,
        assignmentEpoch: parent.assignmentEpoch,
        runSessionId: parent.runSessionId,
        incarnationId: parent.incarnationId,
        commandId: prepared.commandId,
      })
      .returning();

    await appendRunMessage(txDb, {
      runId: run.id,
      nodeAttemptId: null,
      role: "user",
      content: boundPromptBody(prompt).content,
      promptDispatchKey: steerTranscriptKey(prepared.commandId),
      supervisorEventId: await eventHorizon(txDb, run.id),
      delivery: "steered",
    });
    log.info(
      {
        runId: run.id,
        turnId: steerTurn.id,
        parentTurnId: parent.id,
        commandId: prepared.commandId,
        promptBytes: Buffer.byteLength(prompt, "utf8"),
      },
      "agent-steer-issued",
    );

    return { kind: "issued", steerTurn, prepared };
  });
}

/** D-C6: how a steer row answers its caller — the row itself while it is
 * dispatched or applied, its successor once a refusal superseded it. */
export async function steerAnswerTurn(
  db: Db,
  steer: AgentTurn,
): Promise<{ turn: AgentTurn; delivery: "steered" | "queued" }> {
  if (steer.state !== "superseded") return { turn: steer, delivery: "steered" };
  const [successor] = await db
    .select()
    .from(agentTurns)
    .where(
      and(
        eq(agentTurns.runId, steer.runId),
        eq(agentTurns.logicalKey, steerRequeueKey(steer.id)),
      ),
    );

  return successor
    ? { turn: successor, delivery: "queued" }
    : { turn: steer, delivery: "queued" };
}
