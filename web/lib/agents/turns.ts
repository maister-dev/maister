import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { AgentTurn, Run, RunStatus } from "@/lib/db/schema";

import { randomUUID } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";
import pino from "pino";

import { agentTurns, runs } from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";

const log = pino({
  name: "agent-turns",
  level: process.env.LOG_LEVEL ?? "info",
});

// ADR-182 D-C2: the statuses that accept a message, in both delivery modes. A
// `NeedsInput` run's turn is in flight, blocked on a permission — a queued
// message defers (`run_state`) and a steer may still reach the running turn.
const ACCEPTS_MESSAGE = {
  Pending: false,
  Running: true,
  NeedsInput: true,
  NeedsInputIdle: true,
  HumanWorking: false,
  WaitingOnChildren: false,
  Review: false,
  Done: false,
  Failed: false,
  Abandoned: false,
  Crashed: false,
} satisfies Record<RunStatus, boolean>;

// A message turn on a run in these statuses can never be dispatched: the claim
// supersedes it, and a steer converted after the run closed leaves no queued
// successor behind (ADR-182).
export const CLOSES_MESSAGE_TURNS = {
  Pending: false,
  Running: false,
  NeedsInput: false,
  NeedsInputIdle: false,
  HumanWorking: false,
  WaitingOnChildren: false,
  Review: false,
  Done: true,
  Failed: true,
  Abandoned: true,
  Crashed: false,
} satisfies Record<RunStatus, boolean>;

export function messageLogicalKey(requestKey: string | undefined): string {
  return requestKey === undefined
    ? `message:auto:${randomUUID()}`
    : `message:request:${requestKey}`;
}

/** The run row under its lock, refused unless it is a persistent agent run. */
export async function lockPersistentAgentRun(tx: Db, runId: string) {
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

  return run;
}

/** A same-key retry answers the row the key already identifies — a queued or
 * converted message, or a steer (D-C6); different input under it conflicts. */
export async function sameKeyMessage(
  tx: Db,
  runId: string,
  logicalKey: string,
  prompt: string,
): Promise<AgentTurn | null> {
  const [existing] = await tx
    .select()
    .from(agentTurns)
    .where(
      and(eq(agentTurns.runId, runId), eq(agentTurns.logicalKey, logicalKey)),
    );

  if (!existing) return null;
  if (
    existing.prompt !== prompt ||
    !["live_message", "persistent_message", "steer"].includes(existing.variant)
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

export function assertAcceptsAgentMessage(
  run: Pick<Run, "id" | "status">,
): void {
  if (!ACCEPTS_MESSAGE[run.status])
    throw new MaisterError(
      "PRECONDITION",
      "agent run cannot accept a message in its current status",
      {
        details: { runId: run.id, status: run.status },
      },
    );
}

/** Append a queued message at the run's next ordinal. The caller holds the run
 * row lock, which serializes the `max + 1` allocation (ADR-182 trap 7). */
export async function insertAgentMessageTurn(
  tx: Db,
  run: Pick<Run, "id" | "status">,
  prompt: string,
  logicalKey: string,
): Promise<AgentTurn> {
  const [sequence] = await tx
    .select({
      ordinal: sql<number>`coalesce(max(${agentTurns.ordinal}), 0) + 1`,
    })
    .from(agentTurns)
    .where(eq(agentTurns.runId, run.id));
  const [turn] = await tx
    .insert(agentTurns)
    .values({
      id: randomUUID(),
      runId: run.id,
      ordinal: sequence.ordinal,
      variant: run.status === "Running" ? "live_message" : "persistent_message",
      logicalKey,
      prompt,
    })
    .returning();

  return turn;
}

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
  const logicalKey = messageLogicalKey(options.requestKey);
  const accepted = await db.transaction(async (tx): Promise<AgentTurn> => {
    const txDb = tx as unknown as Db;
    const run = await lockPersistentAgentRun(txDb, runId);
    const existing = await sameKeyMessage(txDb, runId, logicalKey, prompt);

    if (existing) return existing;
    assertAcceptsAgentMessage(run);

    return insertAgentMessageTurn(txDb, run, prompt, logicalKey);
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
