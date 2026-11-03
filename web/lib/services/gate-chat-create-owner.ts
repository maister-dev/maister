import "server-only";

import type { Db } from "@/lib/execution-host/db";

import { eq } from "drizzle-orm";

import { gateChatTurns, hitlRequests, runs } from "@/lib/db/schema";

export type GateChatCreateOwner = Readonly<{
  variant: "gate_chat";
  turnId: string;
  hitlRequestId: string;
  userMessageId: string;
}>;

/** The central create owner already holds the current run and assignment. */
export async function lockGateChatCreateOwner(
  tx: Db,
  input: Readonly<{ runId: string; owner: GateChatCreateOwner }>,
): Promise<boolean> {
  const [run] = await tx.select().from(runs).where(eq(runs.id, input.runId));
  const [hitl] = await tx
    .select()
    .from(hitlRequests)
    .where(eq(hitlRequests.id, input.owner.hitlRequestId))
    .for("update");
  const [turn] = await tx
    .select()
    .from(gateChatTurns)
    .where(eq(gateChatTurns.id, input.owner.turnId))
    .for("update");

  return (
    run?.status === "NeedsInput" &&
    hitl?.runId === run.id &&
    (hitl.kind === "human" || hitl.kind === "form") &&
    hitl.response === null &&
    hitl.respondedAt === null &&
    turn?.runId === run.id &&
    turn.hitlRequestId === hitl.id &&
    turn.userMessageId === input.owner.userMessageId &&
    turn.state === "pending"
  );
}
