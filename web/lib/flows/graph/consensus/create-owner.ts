import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { ConsensusCreateOwner } from "@/lib/execution-host/create-owner-contract";
import type { CreateOwnerCheck } from "@/lib/execution-host/create-intent";

import { eq } from "drizzle-orm";

import { consensusVerdictLedgerId } from "./ledger";

import {
  artifactInstances,
  consensusRoundVerdicts,
  nodeAttempts,
  runs,
} from "@/lib/db/schema";

/** A create belongs to the same current matrix cell or synthesis generation as its prompt. */
export async function lockConsensusCreateOwner(
  tx: Db,
  input: Readonly<{
    runId: string;
    assignmentId: string;
    owner: ConsensusCreateOwner;
  }>,
  check: CreateOwnerCheck,
): Promise<boolean> {
  const [run] = await tx.select().from(runs).where(eq(runs.id, input.runId));
  const [attempt] = await tx
    .select()
    .from(nodeAttempts)
    .where(eq(nodeAttempts.id, input.owner.nodeAttemptId))
    .for("update");
  const pausedAck =
    check === "ack" &&
    run &&
    ["NeedsInput", "NeedsInputIdle"].includes(run.status);

  if (
    run?.runKind !== "flow" ||
    !(run.status === "Running" || pausedAck) ||
    !attempt ||
    attempt.runId !== run.id ||
    attempt.executionAssignmentId !== input.assignmentId ||
    attempt.nodeType !== "consensus" ||
    !(
      attempt.status === "Running" ||
      (pausedAck && attempt.status === "NeedsInput")
    ) ||
    run.currentStepId !== attempt.nodeId
  )
    return false;
  if (input.owner.variant === "consensus_verifier") {
    if (
      input.owner.verdictId !==
      consensusVerdictLedgerId({
        nodeAttemptId: input.owner.nodeAttemptId,
        round: input.owner.round,
        verifierId: input.owner.verifierId,
        targetParticipantId: input.owner.targetId,
      })
    )
      return false;
    const [verdict] = await tx
      .select({ id: consensusRoundVerdicts.id })
      .from(consensusRoundVerdicts)
      .where(eq(consensusRoundVerdicts.id, input.owner.verdictId));

    return !verdict;
  }
  if (
    !input.owner.synthesisId.startsWith(
      `run:${attempt.id}:consensus-synthesis:r${input.owner.round}:`,
    )
  )
    return false;
  const [synthesis] = await tx
    .select({ id: artifactInstances.id })
    .from(artifactInstances)
    .where(eq(artifactInstances.id, input.owner.synthesisId));

  return !synthesis;
}
