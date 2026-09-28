import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { AgentTurn } from "@/lib/db/schema";

import { randomUUID } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";
import pino from "pino";

import { agentTurns, runs } from "@/lib/db/schema";
import { steerRequeueKey } from "@/lib/execution-host/steer-settlement";

const log = pino({
  name: "agent-host-park",
  level: process.env.LOG_LEVEL ?? "info",
});

const MESSAGE_VARIANTS: ReadonlySet<AgentTurn["variant"]> = new Set([
  "live_message",
  "persistent_message",
]);

/** The turns a host park can resume. A message is re-queued as a successor;
 * an initial/resume generation is repeated by the resume generation, which
 * the resume invariant (`assertAgentResumeTurn`) admits only after an APPLIED
 * previous turn with the same input. A rework's input is not the agent's base
 * prompt, and a consensus draft is owned by its parent — neither can be
 * repeated that way, so they keep their existing failure settlement. */
export const HOST_PARKABLE_AGENT_VARIANTS: ReadonlySet<AgentTurn["variant"]> =
  new Set(["initial", "resume", "live_message", "persistent_message"]);

export type HostParkedTurnSettlement = Readonly<{
  settled: boolean;
  successor: AgentTurn | null;
}>;

/** ADR-183 D-M3: the execution host parked this turn's session under outbox
 * pressure. A MESSAGE is superseded and re-queued as its successor — same
 * variant, same text, keyed off the parent (`message:requeue:<turnId>`, the
 * ADR-182 successor shape) — so the resumed session receives it again:
 * at-least-once, as a steer refusal is.
 *
 * An initial/resume generation is closed `applied` with no successor: the
 * resume re-admits a `resume` generation with the same input under the
 * placement it mints, on the same ACP session, which still holds the
 * interrupted turn's context — the shape `assertAgentResumeTurn` verifies.
 *
 * Idempotent: a turn no longer dispatched under this command was settled
 * already, and its successor (if any) is returned.
 */
export async function settleHostParkedAgentTurn(
  tx: Db,
  input: Readonly<{ runId: string; turnId: string; commandId: string }>,
): Promise<HostParkedTurnSettlement> {
  // The successor's `max + 1` ordinal is allocated under the run lock.
  await tx
    .select({ id: runs.id })
    .from(runs)
    .where(eq(runs.id, input.runId))
    .for("update");
  const [turn] = await tx
    .select()
    .from(agentTurns)
    .where(eq(agentTurns.id, input.turnId))
    .for("update");
  const successorOf = async (): Promise<AgentTurn | null> => {
    const [successor] = await tx
      .select()
      .from(agentTurns)
      .where(
        and(
          eq(agentTurns.runId, input.runId),
          eq(agentTurns.logicalKey, steerRequeueKey(input.turnId)),
        ),
      );

    return successor ?? null;
  };

  if (
    !turn ||
    turn.runId !== input.runId ||
    turn.state !== "dispatched" ||
    turn.commandId !== input.commandId
  )
    return { settled: false, successor: await successorOf() };
  const now = new Date();
  const message = MESSAGE_VARIANTS.has(turn.variant);

  await tx
    .update(agentTurns)
    .set({
      state: message ? "superseded" : "applied",
      completedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(agentTurns.id, turn.id),
        eq(agentTurns.state, "dispatched"),
        eq(agentTurns.commandId, input.commandId),
      ),
    );
  if (!message) {
    log.warn(
      { runId: turn.runId, turnId: turn.id, variant: turn.variant },
      "agent-turn-host-pressure-parked",
    );

    return { settled: true, successor: null };
  }
  const successor = await insertHostParkSuccessor(tx, turn);

  log.warn(
    {
      runId: turn.runId,
      turnId: turn.id,
      successorTurnId: successor.id,
    },
    "agent-turn-host-pressure-requeued",
  );

  return { settled: true, successor };
}

/** The successor of a message the host parked (or refused to dispatch). The
 * caller holds the run lock that serializes the `max + 1` ordinal. */
export async function insertHostParkSuccessor(
  tx: Db,
  turn: AgentTurn,
): Promise<AgentTurn> {
  const [sequence] = await tx
    .select({
      ordinal: sql<number>`coalesce(max(${agentTurns.ordinal}), 0) + 1`,
    })
    .from(agentTurns)
    .where(eq(agentTurns.runId, turn.runId));
  const [successor] = await tx
    .insert(agentTurns)
    .values({
      id: randomUUID(),
      runId: turn.runId,
      ordinal: sequence.ordinal,
      variant: turn.variant,
      logicalKey: steerRequeueKey(turn.id),
      prompt: turn.prompt,
    })
    .returning();

  return successor;
}
