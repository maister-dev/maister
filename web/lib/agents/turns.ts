import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { AgentTurn } from "@/lib/db/schema";

import { randomUUID } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";
import pino from "pino";

import { agentTurns, runs } from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";

const log = pino({
  name: "agent-turns",
  level: process.env.LOG_LEVEL ?? "info",
});

/** Persist accepted input before a caller attempts any slot or host operation. */
export async function acceptAgentMessage(
  db: Db,
  runId: string,
  prompt: string,
  options: Readonly<{ requestKey?: string }> = {},
): Promise<AgentTurn> {
  if (prompt.length === 0 || prompt.length > 1_000_000)
    throw new MaisterError(
      "CONFIG",
      "agent message must contain 1 to 1000000 characters",
    );
  if (
    options.requestKey !== undefined &&
    (options.requestKey.length === 0 || options.requestKey.length > 128)
  )
    throw new MaisterError(
      "CONFIG",
      "agent message request key must contain 1 to 128 characters",
    );
  const logicalKey =
    options.requestKey === undefined
      ? `message:auto:${randomUUID()}`
      : `message:request:${options.requestKey}`;
  const accepted = await db.transaction(async (tx): Promise<AgentTurn> => {
    const [run] = await tx
      .select()
      .from(runs)
      .where(eq(runs.id, runId))
      .for("update");

    if (!run || run.runKind !== "agent" || !run.persistent)
      throw new MaisterError(
        "PRECONDITION",
        "agent messages require a persistent agent run",
        { details: { runId } },
      );
    const [existing] = await tx
      .select()
      .from(agentTurns)
      .where(
        and(eq(agentTurns.runId, runId), eq(agentTurns.logicalKey, logicalKey)),
      );

    if (existing) {
      if (
        existing.prompt !== prompt ||
        !["live_message", "persistent_message"].includes(existing.variant)
      )
        throw new MaisterError(
          "CONFLICT",
          "agent message request key already identifies different input",
          {
            details: {
              reason: "agent_turn_request_conflict",
              runId,
              turnId: existing.id,
            },
          },
        );

      return existing;
    }
    if (run.status !== "Running" && run.status !== "NeedsInputIdle")
      throw new MaisterError(
        "PRECONDITION",
        "agent run cannot accept a message in its current status",
        {
          details: { runId, status: run.status },
        },
      );
    const [sequence] = await tx
      .select({
        ordinal: sql<number>`coalesce(max(${agentTurns.ordinal}), 0) + 1`,
      })
      .from(agentTurns)
      .where(eq(agentTurns.runId, runId));
    const [turn] = await tx
      .insert(agentTurns)
      .values({
        id: randomUUID(),
        runId,
        ordinal: sequence.ordinal,
        variant:
          run.status === "Running" ? "live_message" : "persistent_message",
        logicalKey,
        prompt,
      })
      .returning();

    return turn;
  });

  log.info(
    {
      runId,
      turnId: accepted.id,
      variant: accepted.variant,
      ordinal: accepted.ordinal,
      state: accepted.state,
    },
    "agent-message-accepted",
  );

  return accepted;
}
