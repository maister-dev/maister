import "server-only";

import type { BoundClient } from "@/lib/execution-host/client";
import type { Db } from "@/lib/execution-host/db";
import type { ExecutionCommand } from "@/lib/db/schema";
import type { PromptOwnerAdmission } from "@/lib/execution-host/ledger";
import type {
  PreparedPromptOwner,
  PromptOwnerOutcome,
} from "@/lib/execution-host/prompt-owners";
import type { FlowOwnerRef } from "../prompt-owner-authority";
import type { ConsensusNodeDef } from "./drafts";

import { and, eq } from "drizzle-orm";
import pino from "pino";

import { compileManifest } from "../compile";
import { recordArtifact } from "../artifact-store";
import { loadRun } from "../runner-core";
import { lockFlowPromptOwner } from "../prompt-owner-authority";

import {
  CONSENSUS_TEXT_CAP_BYTES,
  consensusVerdictLedgerId,
  writeConsensusVerdict,
} from "./ledger";
import { parseConsensusVerdict } from "./verdict";

import {
  artifactInstances,
  consensusRoundVerdicts,
  nodeAttempts,
  runSessionIncarnations,
  runSessions,
  runs,
} from "@/lib/db/schema";
import {
  lockCurrentSessionAssignment,
  staleSessionBinding,
} from "@/lib/execution-host/session-binding";
import { PromptOwnerInvariantError } from "@/lib/execution-host/prompt-owners";
import { MaisterError } from "@/lib/errors";
import { agentMessageText } from "@/lib/run-transcript/agent-text";

const log = pino({
  name: "consensus-prompt-owner",
  level: process.env.LOG_LEVEL ?? "info",
});

/** The paid turn's own application still owes this generation its row. An
 * unavailable result is never a failed check or an empty plan. */
export class ConsensusGenerationPending extends MaisterError {
  constructor(generationId: string) {
    super("PRECONDITION", "consensus generation awaits its owner application", {
      details: { reason: "consensus_generation_pending", generationId },
    });
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export type ConsensusPromptOwner =
  | Readonly<{
      variant: "consensus_verifier";
      nodeAttemptId: string;
      round: number;
      verifierId: string;
      targetId: string;
      verdictId: string;
    }>
  | Readonly<{
      variant: "consensus_synthesis";
      nodeAttemptId: string;
      round: number;
      synthesisId: string;
    }>;

/** A synthesis generation is its attempt, its round and the source that
 * produced it, so a human resolution never overwrites the agreed synthesis. */
export function consensusSynthesisArtifactId(generation: {
  nodeAttemptId: string;
  round: number;
  source: string;
}): string {
  return `run:${generation.nodeAttemptId}:consensus-synthesis:r${generation.round}:${generation.source}`;
}

export function consensusSynthesisOwner(generation: {
  nodeAttemptId: string;
  round: number;
  source: string;
}): Extract<ConsensusPromptOwner, { variant: "consensus_synthesis" }> {
  return {
    variant: "consensus_synthesis",
    nodeAttemptId: generation.nodeAttemptId,
    round: generation.round,
    synthesisId: consensusSynthesisArtifactId(generation),
  };
}

/** The applied generation's own output, or null while it is still unpaid. */
export async function loadConsensusSynthesis(input: {
  db: Db;
  synthesisId: string;
}): Promise<string | null> {
  const [artifact] = await input.db
    .select()
    .from(artifactInstances)
    .where(eq(artifactInstances.id, input.synthesisId));

  return artifact?.locator?.kind === "inline" ? artifact.locator.text : null;
}

export function consensusVerifierOwner(cell: {
  nodeAttemptId: string;
  round: number;
  verifierId: string;
  targetParticipantId: string;
}): Extract<ConsensusPromptOwner, { variant: "consensus_verifier" }> {
  return {
    variant: "consensus_verifier",
    nodeAttemptId: cell.nodeAttemptId,
    round: cell.round,
    verifierId: cell.verifierId,
    targetId: cell.targetParticipantId,
    verdictId: consensusVerdictLedgerId(cell),
  };
}

export function consensusPromptOperationKey(
  owner: ConsensusPromptOwner,
): string {
  return `flow_node_attempt:${owner.variant}:${
    owner.variant === "consensus_verifier" ? owner.verdictId : owner.synthesisId
  }`;
}

type ConsensusOwnerRef = Extract<
  FlowOwnerRef,
  { variant: "consensus_verifier" | "consensus_synthesis" }
>;

async function lockConsensusAttempt(
  tx: Db,
  runId: string,
  owner: ConsensusPromptOwner,
): Promise<void> {
  const [run] = await tx.select().from(runs).where(eq(runs.id, runId));
  const [attempt] = await tx
    .select()
    .from(nodeAttempts)
    .where(eq(nodeAttempts.id, owner.nodeAttemptId))
    .for("update");

  if (
    run?.runKind !== "flow" ||
    run.status !== "Running" ||
    !attempt ||
    attempt.runId !== runId ||
    attempt.nodeType !== "consensus" ||
    attempt.status !== "Running" ||
    run.currentStepId !== attempt.nodeId ||
    (owner.variant === "consensus_verifier" &&
      owner.verdictId !==
        consensusVerdictLedgerId({
          nodeAttemptId: owner.nodeAttemptId,
          round: owner.round,
          verifierId: owner.verifierId,
          targetParticipantId: owner.targetId,
        }))
  )
    throw new PromptOwnerInvariantError("consensus_admission_generation");
}

async function consensusGenerationRecorded(
  tx: Db,
  owner: ConsensusPromptOwner | ConsensusOwnerRef,
): Promise<boolean> {
  if (owner.variant === "consensus_verifier") {
    const [recorded] = await tx
      .select({ id: consensusRoundVerdicts.id })
      .from(consensusRoundVerdicts)
      .where(eq(consensusRoundVerdicts.id, owner.verdictId));

    return recorded !== undefined;
  }
  const [recorded] = await tx
    .select({ id: artifactInstances.id })
    .from(artifactInstances)
    .where(eq(artifactInstances.id, owner.synthesisId));

  return recorded !== undefined;
}

/** A verification turn belongs to exactly one matrix cell. Its already recorded
 * verdict is evidence that the cell was paid for, never a reason to re-verify.
 */
export async function admitConsensusPrompt(
  tx: Db,
  client: BoundClient,
  hostSessionId: string,
  owner: ConsensusPromptOwner,
): Promise<PromptOwnerAdmission> {
  const runId = client.assignment.runId;
  const assignment = await lockCurrentSessionAssignment(tx, {
    runId,
    assignmentId: client.assignment.id,
  });

  if (!assignment) throw staleSessionBinding(runId, client.assignment.id);
  await lockConsensusAttempt(tx, runId, owner);
  if (await consensusGenerationRecorded(tx, owner))
    throw new PromptOwnerInvariantError("consensus_generation_recorded");
  const [binding] = await tx
    .select({ session: runSessions, incarnation: runSessionIncarnations })
    .from(runSessions)
    .innerJoin(
      runSessionIncarnations,
      eq(runSessionIncarnations.runSessionId, runSessions.id),
    )
    .where(
      and(
        eq(runSessions.runId, runId),
        eq(runSessions.executionAssignmentId, assignment.id),
        eq(runSessions.hostSessionId, hostSessionId),
        eq(runSessionIncarnations.hostSessionId, hostSessionId),
        eq(runSessionIncarnations.executionHostId, client.host.id),
        eq(runSessionIncarnations.state, "active"),
      ),
    )
    .for("update")
    .limit(1);

  if (!binding)
    throw new PromptOwnerInvariantError("consensus_admission_incarnation");

  return {
    owner: {
      kind: "flow_node_attempt",
      ref: {
        version: 1,
        ...owner,
        runId,
        runSessionId: binding.session.id,
        incarnationId: binding.incarnation.id,
        assignmentId: assignment.id,
        assignmentEpoch: assignment.epoch,
      },
    },
    logicalOperationKey: consensusPromptOperationKey(owner),
  };
}

async function consensusMaterialAxes(
  db: Db,
  ref: ConsensusOwnerRef,
): Promise<readonly string[]> {
  const loaded = await loadRun(db, ref.runId);
  const [attempt] = await db
    .select()
    .from(nodeAttempts)
    .where(eq(nodeAttempts.id, ref.nodeAttemptId));

  if (!attempt || attempt.runId !== ref.runId)
    throw new PromptOwnerInvariantError("consensus_owner_attempt_missing");
  const node = compileManifest(loaded.manifest).nodes.get(attempt.nodeId);

  if (node?.nodeType !== "consensus")
    throw new PromptOwnerInvariantError("consensus_owner_definition_missing");

  return (node.source.node as ConsensusNodeDef).material_axes;
}

/** The complete verified output decides the cell; a raced stack read cannot. */
export async function prepareConsensusPrompt(input: {
  db: Db;
  ref: ConsensusOwnerRef;
  command: Readonly<ExecutionCommand>;
  outcome: PromptOwnerOutcome;
}): Promise<PreparedPromptOwner> {
  const { db, ref, command, outcome } = input;
  const materialAxes =
    ref.variant === "consensus_verifier"
      ? await consensusMaterialAxes(db, ref)
      : [];
  let rawOutput = "";

  if (outcome.state === "succeeded") {
    for await (const event of outcome.events) {
      if (event.eventType !== "session.update") continue;
      const chunk = agentMessageText(event.payload?.update);

      if (chunk === null) continue;
      const remaining = CONSENSUS_TEXT_CAP_BYTES - rawOutput.length;

      if (remaining > 0) rawOutput += chunk.slice(0, remaining);
    }
  }
  const ok =
    outcome.state === "succeeded" && outcome.response.stopReason === "end_turn";
  const errorCode = ok
    ? undefined
    : outcome.state === "succeeded"
      ? "ACP_PROTOCOL"
      : String(outcome.error.code ?? "EXECUTOR_UNAVAILABLE");
  // A failed host turn still owes the round a persisted fail-closed cell.
  const result = parseConsensusVerdict(ok ? rawOutput : "", materialAxes);

  return {
    apply: async (tx) => {
      if (!(await lockFlowPromptOwner(tx, ref, command.targetSessionId)))
        return "superseded";
      const [run] = await tx.select().from(runs).where(eq(runs.id, ref.runId));
      const [attempt] = await tx
        .select()
        .from(nodeAttempts)
        .where(eq(nodeAttempts.id, ref.nodeAttemptId))
        .for("update");
      const existing = await consensusGenerationRecorded(tx, ref);

      if (
        existing ||
        !attempt ||
        run?.runKind !== "flow" ||
        !["Running", "NeedsInput"].includes(run.status) ||
        attempt.runId !== ref.runId ||
        attempt.nodeType !== "consensus" ||
        attempt.status !== "Running" ||
        run.currentStepId !== attempt.nodeId
      )
        return "superseded";
      if (ref.variant === "consensus_synthesis") {
        // An empty or non-`end_turn` synthesis records its generation's failure
        // evidence; the caller then fails the node on its existing path.
        await recordArtifact(
          {
            id: ref.synthesisId,
            runId: ref.runId,
            nodeId: attempt.nodeId,
            nodeAttemptId: ref.nodeAttemptId,
            attempt: attempt.attempt,
            artifactDefId: "default:consensus-synthesis",
            kind: "plan",
            producer: "runner",
            locator: { kind: "inline", text: ok ? rawOutput : "" },
            validity: "current",
            visibility: "internal",
            retention: "run",
          },
          tx,
        );
        log.info(
          {
            runId: ref.runId,
            nodeAttemptId: ref.nodeAttemptId,
            round: ref.round,
            synthesisId: ref.synthesisId,
            commandId: command.id,
            ok,
          },
          "consensus-synthesis-applied",
        );

        return "applied";
      }
      await writeConsensusVerdict(tx, {
        runId: ref.runId,
        nodeId: attempt.nodeId,
        nodeAttemptId: ref.nodeAttemptId,
        attempt: attempt.attempt,
        round: ref.round,
        verifierId: ref.verifierId,
        targetParticipantId: ref.targetId,
        result,
        rawOutput: ok ? rawOutput : (errorCode ?? ""),
        ...(errorCode ? { errorCode } : {}),
      });
      log.info(
        {
          runId: ref.runId,
          nodeAttemptId: ref.nodeAttemptId,
          round: ref.round,
          verifierId: ref.verifierId,
          targetId: ref.targetId,
          verdictId: ref.verdictId,
          commandId: command.id,
          verdict: result.verdict,
          parseStatus: result.parseStatus,
        },
        "consensus-verdict-applied",
      );

      return "applied";
    },
  };
}
