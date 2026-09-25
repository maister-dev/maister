import type { Db } from "./db";
import type { AgentTurn } from "@/lib/db/schema";

import { and, eq, sql } from "drizzle-orm";
import pino, { type Logger } from "pino";

import { agentTurns, runMessages, runs } from "@/lib/db/schema";
import { insertAgentMessageTurn } from "@/lib/agents/turns";

const defaultLog = pino({
  name: "execution-host",
  level: process.env.LOG_LEVEL ?? "info",
}).child({ component: "steer-settlement" });

// ADR-182 D-C5: the ONE writer of a steer's terminal domain state. The live
// ack (`onAck`), the live refusal (`onReject`), the receipt fold and the
// orphan pass all call it inside the transaction that writes the ledger's
// terminal state, with the run row already locked — so a steer's domain row
// can never lag its command. A successor is created only from a definitive
// host answer (`refused`), never from an unknown outcome: that is what makes
// delivery exactly-once.

export type SteerOutcome =
  | Readonly<{ kind: "injected" }>
  // A definitive host refusal, FENCED, an orphaned intent, or a lost turn:
  // the message never reached the running turn.
  | Readonly<{ kind: "refused"; reason: string }>;

export type SteerSettlement =
  | Readonly<{
      domain: "agent";
      kind: "applied" | "converted" | "already_settled";
      steerTurn: AgentTurn;
      successor: AgentTurn | null;
    }>
  | Readonly<{
      domain: "scratch";
      kind: "applied" | "requeued" | "already_settled";
      runId: string;
      messageId: string;
      sequence: number;
    }>
  | Readonly<{ domain: "none" }>;

export function steerRequeueKey(steerTurnId: string): string {
  return `message:requeue:${steerTurnId}`;
}

export async function settleSteerCommand(
  tx: Db,
  command: Readonly<{ id: string; runId: string }>,
  outcome: SteerOutcome,
  opts: { logger?: Logger; now?: Date } = {},
): Promise<SteerSettlement> {
  const logger = opts.logger ?? defaultLog;
  const now = opts.now ?? new Date();
  const [steer] = await tx
    .select()
    .from(agentTurns)
    .where(
      and(
        eq(agentTurns.commandId, command.id),
        eq(agentTurns.variant, "steer"),
      ),
    )
    .for("update");

  if (steer) return settleAgentSteer(tx, steer, outcome, { logger, now });

  const [message] = await tx
    .select()
    .from(runMessages)
    .where(eq(runMessages.steerCommandId, command.id))
    .for("update");

  if (message) {
    if (outcome.kind === "injected" || message.delivery !== "steered") {
      const kind = outcome.kind === "injected" ? "applied" : "already_settled";

      logger.info(
        {
          runId: message.runId,
          messageId: message.id,
          commandId: command.id,
          outcome: outcome.kind,
          delivery: message.delivery,
        },
        kind === "applied"
          ? "scratch-steer-applied"
          : "steer-settlement-already-applied",
      );

      return {
        domain: "scratch",
        kind,
        runId: message.runId,
        messageId: message.id,
        sequence: message.sequence,
      };
    }
    const [requeued] = await tx
      .update(runMessages)
      .set({ delivery: "queued" })
      .where(
        and(
          eq(runMessages.id, message.id),
          eq(runMessages.delivery, "steered"),
          eq(runMessages.steerCommandId, command.id),
        ),
      )
      .returning({ id: runMessages.id });

    logger.info(
      {
        runId: message.runId,
        messageId: message.id,
        commandId: command.id,
        reason: outcome.reason,
        written: Boolean(requeued),
      },
      "scratch-message-queued",
    );

    return {
      domain: "scratch",
      kind: requeued ? "requeued" : "already_settled",
      runId: message.runId,
      messageId: message.id,
      sequence: message.sequence,
    };
  }

  logger.warn(
    { commandId: command.id, runId: command.runId, outcome: outcome.kind },
    "steer-settlement-no-domain-row",
  );

  return { domain: "none" };
}

async function settleAgentSteer(
  tx: Db,
  steer: AgentTurn,
  outcome: SteerOutcome,
  opts: { logger: Logger; now: Date },
): Promise<SteerSettlement> {
  const successorOf = async (): Promise<AgentTurn | null> => {
    const [successor] = await tx
      .select()
      .from(agentTurns)
      .where(
        and(
          eq(agentTurns.runId, steer.runId),
          eq(agentTurns.logicalKey, steerRequeueKey(steer.id)),
        ),
      );

    return successor ?? null;
  };

  if (steer.state !== "dispatched") {
    opts.logger.info(
      {
        runId: steer.runId,
        turnId: steer.id,
        commandId: steer.commandId,
        state: steer.state,
        outcome: outcome.kind,
      },
      "steer-settlement-already-applied",
    );

    return {
      domain: "agent",
      kind: "already_settled",
      steerTurn: steer,
      successor: await successorOf(),
    };
  }
  const target = outcome.kind === "injected" ? "applied" : "superseded";
  const [settled] = await tx
    .update(agentTurns)
    .set({ state: target, completedAt: opts.now, updatedAt: opts.now })
    .where(
      and(
        eq(agentTurns.id, steer.id),
        eq(agentTurns.state, "dispatched"),
        eq(agentTurns.commandId, steer.commandId as string),
      ),
    )
    .returning();

  if (outcome.kind === "injected") {
    opts.logger.info(
      {
        runId: steer.runId,
        turnId: steer.id,
        parentTurnId: steer.parentTurnId,
        commandId: steer.commandId,
      },
      "agent-steer-applied",
    );

    return {
      domain: "agent",
      kind: "applied",
      steerTurn: settled,
      successor: null,
    };
  }
  const [run] = await tx
    .select({ id: runs.id, status: runs.status })
    .from(runs)
    .where(eq(runs.id, steer.runId));
  const successor = await insertAgentMessageTurn(
    tx,
    run,
    steer.prompt,
    steerRequeueKey(steer.id),
  );

  await tx
    .update(runs)
    .set({
      resumeRequestedAt: sql`coalesce(${runs.resumeRequestedAt}, ${opts.now})`,
    })
    .where(eq(runs.id, steer.runId));
  opts.logger.info(
    {
      runId: steer.runId,
      turnId: steer.id,
      successorTurnId: successor.id,
      successorOrdinal: successor.ordinal,
      commandId: steer.commandId,
      reason: outcome.reason,
    },
    "agent-steer-converted",
  );

  return {
    domain: "agent",
    kind: "converted",
    steerTurn: settled,
    successor,
  };
}

/** The refusal reason a ledger error record carries, for the settlement log. */
export function steerRefusalReason(error: unknown): string {
  const record =
    error && typeof error === "object"
      ? (error as {
          code?: unknown;
          reason?: unknown;
          details?: { reason?: unknown };
        })
      : null;
  const reason = record?.details?.reason ?? record?.reason;

  if (typeof reason === "string") return reason;

  return typeof record?.code === "string" ? record.code : "refused";
}
