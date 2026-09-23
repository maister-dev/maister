import "server-only";

import type { Db } from "@/lib/execution-host/db";

import { and, desc, eq, sql } from "drizzle-orm";

import {
  artifactInstances,
  executionCommands,
  nodeAttempts,
} from "@/lib/db/schema";

export type ConsensusRecoveryEvidence = Readonly<{
  incompleteSynthesis: boolean;
  quarantined: boolean;
}>;

/** Only the latest failed node attempt can authorize fresh synthesis work. */
export async function loadConsensusRecoveryEvidence(
  db: Db,
  input: { runId: string; nodeId: string | null },
): Promise<ConsensusRecoveryEvidence> {
  if (!input.nodeId) return { incompleteSynthesis: false, quarantined: false };
  const [attempt] = await db
    .select({
      id: nodeAttempts.id,
      status: nodeAttempts.status,
      errorCode: nodeAttempts.errorCode,
    })
    .from(nodeAttempts)
    .where(
      and(
        eq(nodeAttempts.runId, input.runId),
        eq(nodeAttempts.nodeId, input.nodeId),
        eq(nodeAttempts.nodeType, "consensus"),
      ),
    )
    .orderBy(desc(nodeAttempts.attempt))
    .limit(1);

  if (!attempt) return { incompleteSynthesis: false, quarantined: false };
  const [conflict] = await db
    .select({ id: executionCommands.id })
    .from(executionCommands)
    .where(
      and(
        eq(executionCommands.runId, input.runId),
        eq(executionCommands.kind, "session.prompt"),
        sql`${executionCommands.ownerRef}->>'nodeAttemptId' = ${attempt.id}`,
        sql`${executionCommands.ownerRef}->>'variant' IN ('consensus_verifier', 'consensus_synthesis')`,
        sql`${executionCommands.applicationError}->>'reason' = 'prompt_terminal_conflict'`,
      ),
    )
    .limit(1);

  if (conflict) return { incompleteSynthesis: false, quarantined: true };
  if (attempt.status !== "Failed" || attempt.errorCode !== "CRASH")
    return { incompleteSynthesis: false, quarantined: false };
  const [witness] = await db
    .select({ id: artifactInstances.id })
    .from(artifactInstances)
    .innerJoin(
      executionCommands,
      sql`${executionCommands.ownerRef}->>'synthesisId' = ${artifactInstances.id}`,
    )
    .where(
      and(
        eq(artifactInstances.runId, input.runId),
        eq(artifactInstances.nodeAttemptId, attempt.id),
        eq(artifactInstances.artifactDefId, "default:consensus-synthesis"),
        sql`${artifactInstances.locator}->>'reason' = 'consensus_synthesis_incomplete'`,
        eq(executionCommands.runId, input.runId),
        eq(executionCommands.applicationState, "applied"),
        sql`${executionCommands.ownerRef}->>'variant' = 'consensus_synthesis'`,
        sql`${executionCommands.ownerRef}->>'nodeAttemptId' = ${attempt.id}`,
      ),
    )
    .limit(1);

  return { incompleteSynthesis: Boolean(witness), quarantined: false };
}
