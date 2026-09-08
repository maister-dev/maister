import type { SessionPolicy } from "@/lib/config.schema";
import type { Db } from "./runner-core";

import { and, eq, isNotNull, isNull } from "drizzle-orm";

import { nodeAttempts, runs } from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";

/** The selected outgoing edge and private input context of a finished attempt.
 * Written with that attempt's close and the run cursor. Recovery consumes this
 * same decision; it does not recalculate an edge or authorize another ACP turn.
 */
export type FlowFinishContinuation = Readonly<{
  version: 1;
  targetNodeId: string | null;
  injectedVars: Readonly<Record<string, unknown>>;
  sessionPolicy: SessionPolicy | null;
  autoRetry: boolean;
}>;

/** Called inside the same transaction that closes the source attempt. */
export async function persistFinishContinuation(
  tx: Db,
  runId: string,
  nodeAttemptId: string,
  continuation: FlowFinishContinuation,
): Promise<void> {
  const rows = await tx
    .update(nodeAttempts)
    .set({ finishContinuation: continuation })
    .where(
      and(
        eq(nodeAttempts.id, nodeAttemptId),
        eq(nodeAttempts.runId, runId),
        isNotNull(nodeAttempts.endedAt),
        isNull(nodeAttempts.finishContinuation),
      ),
    )
    .returning({ id: nodeAttempts.id });

  if (rows.length !== 1)
    throw new MaisterError("CONFLICT", "Flow finish source is not available", {
      details: { runId, nodeAttemptId },
    });

  await tx
    .update(runs)
    .set({ currentStepId: continuation.targetNodeId })
    .where(eq(runs.id, runId));
}
