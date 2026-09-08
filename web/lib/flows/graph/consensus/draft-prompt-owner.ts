import "server-only";

import type { BoundClient } from "@/lib/execution-host/client";
import type { Db } from "@/lib/execution-host/db";
import type { PromptOwnerAdmission } from "@/lib/execution-host/ledger";
import type { PromptOwner } from "@/lib/execution-host/prompt-owner-contract";
import type {
  PreparedPromptOwner,
  PromptOwnerRegistry,
} from "@/lib/execution-host/prompt-owners";
import type { AgentFinalizationApplication } from "@/lib/agents/finalization";
import type { ConsensusDraftPromptPreparation } from "@/lib/agents/prompt-owner";

import { eq } from "drizzle-orm";
import pino from "pino";

import { recordArtifact } from "../artifact-store";

import { prepareAgentRunFinalization } from "@/lib/agents/finalization";
import {
  acknowledgeAgentMessage,
  awaitAgentApplication,
  bindAgentTurnCommand,
  createAgentPromptOwners,
  lockAgentOwner,
  lockAgentPromptSession,
  stopAgentPromptSession,
  supersedeAgentMessage,
} from "@/lib/agents/prompt-owner";
import { agentTurns, runs } from "@/lib/db/schema";
import { PromptOwnerInvariantError } from "@/lib/execution-host/prompt-owners";
import { agentMessageText } from "@/lib/run-transcript/agent-text";

const log = pino({
  name: "consensus-draft-prompt-owner",
  level: process.env.LOG_LEVEL ?? "info",
});

export const CONSENSUS_DRAFT_OUTPUT_CAP_BYTES = 1024 * 1024;

type DraftRef = Extract<
  Extract<PromptOwner, { kind: "agent_turn" }>["ref"],
  { variant: "consensus_draft" }
>;

export type ConsensusDraftSource = Readonly<{
  nodeId: string;
  nodeAttemptId: string;
  round: number;
  participantId: string;
}>;

export function consensusDraftOperationKey(turnId: string): string {
  return `agent_turn:consensus_draft:${turnId}:0`;
}

export function consensusDraftArtifactId(
  runId: string,
  source: ConsensusDraftSource,
): string {
  return `run:${runId}:consensus-draft:${source.nodeAttemptId}:${source.participantId}:r${source.round}`;
}

/** The child run's immutable trigger payload is the draft's only source of
 * round/participant identity; a rewritten payload cannot rebind a live turn. */
export function readConsensusDraftSource(
  triggerPayload: unknown,
): ConsensusDraftSource | null {
  if (
    triggerPayload === null ||
    typeof triggerPayload !== "object" ||
    Array.isArray(triggerPayload)
  )
    return null;
  const payload = triggerPayload as Record<string, unknown>;

  if (
    payload.kind !== "consensus_draft" ||
    typeof payload.nodeId !== "string" ||
    typeof payload.nodeAttemptId !== "string" ||
    typeof payload.participantId !== "string" ||
    typeof payload.round !== "number" ||
    !Number.isInteger(payload.round) ||
    payload.round < 0
  )
    return null;

  return {
    nodeId: payload.nodeId,
    nodeAttemptId: payload.nodeAttemptId,
    round: payload.round,
    participantId: payload.participantId,
  };
}

export async function admitConsensusDraftPrompt(
  tx: Db,
  client: BoundClient,
  hostSessionId: string,
  turnId: string,
): Promise<PromptOwnerAdmission> {
  const { placementReason, ...session } = await lockAgentPromptSession(
    tx,
    client,
    hostSessionId,
  );

  if (!["launch", "legacy_backfill"].includes(placementReason))
    throw new PromptOwnerInvariantError("consensus_draft_admission_generation");
  const [turn] = await tx
    .select()
    .from(agentTurns)
    .where(eq(agentTurns.id, turnId))
    .for("update");

  if (
    !turn ||
    turn.variant !== "consensus_draft" ||
    turn.id !== session.assignmentId ||
    turn.ordinal !== 0 ||
    !["claimed", "dispatched"].includes(turn.state) ||
    turn.runId !== session.runId ||
    turn.executionAssignmentId !== session.assignmentId ||
    turn.assignmentEpoch !== session.assignmentEpoch ||
    turn.runSessionId !== session.runSessionId
  )
    throw new PromptOwnerInvariantError("consensus_draft_admission_turn");
  const [run] = await tx
    .select({
      triggerPayload: runs.triggerPayload,
      parentRunId: runs.parentRunId,
    })
    .from(runs)
    .where(eq(runs.id, session.runId));
  const source = readConsensusDraftSource(run?.triggerPayload);

  if (!source || !run?.parentRunId)
    throw new PromptOwnerInvariantError("consensus_draft_admission_source");

  return {
    owner: {
      kind: "agent_turn",
      ref: {
        ...session,
        variant: "consensus_draft",
        turnId: turn.id,
        promptOrdinal: 0,
        nodeAttemptId: source.nodeAttemptId,
        round: source.round,
        participantId: source.participantId,
      },
    },
    logicalOperationKey: consensusDraftOperationKey(turn.id),
    assertCommit: () =>
      bindAgentTurnCommand(tx, {
        turn,
        hostKey: client.host.hostKey,
        incarnationId: session.incarnationId,
        logicalOperationKey: consensusDraftOperationKey(turn.id),
      }),
  };
}

/** The complete verified command output is the draft. Text that only ever
 * existed on a dead consumer stack can never become a successful empty draft.
 */
export async function prepareConsensusDraftPrompt(
  context: ConsensusDraftPromptPreparation,
): Promise<PreparedPromptOwner> {
  const { db, command, outcome } = context;
  const ref: DraftRef = context.owner.ref;
  let text = "";

  if (outcome.state === "succeeded") {
    for await (const event of outcome.events) {
      if (event.eventType !== "session.update") continue;
      const chunk = agentMessageText(event.payload?.update);

      if (chunk === null) continue;
      const remaining = CONSENSUS_DRAFT_OUTPUT_CAP_BYTES - text.length;

      if (remaining > 0) text += chunk.slice(0, remaining);
    }
  }
  const [run] = await db
    .select({ triggerPayload: runs.triggerPayload })
    .from(runs)
    .where(eq(runs.id, ref.runId));
  const source = readConsensusDraftSource(run?.triggerPayload);

  if (
    !source ||
    source.nodeAttemptId !== ref.nodeAttemptId ||
    source.round !== ref.round ||
    source.participantId !== ref.participantId
  )
    throw new PromptOwnerInvariantError("consensus_draft_owner_source");
  const complete =
    outcome.state === "succeeded" &&
    outcome.response.stopReason === "end_turn" &&
    text.trim().length > 0;

  if (outcome.state !== "fenced")
    await stopAgentPromptSession(db, ref, command.targetSessionId, command.id);
  const prepared = await prepareAgentRunFinalization(
    ref.runId,
    complete ? "Done" : "Failed",
    {
      db,
      ...(complete ? {} : { reason: "consensus_draft_incomplete" }),
    },
  );
  let application: AgentFinalizationApplication = { finalized: false };

  return {
    apply: async (tx) => {
      if (
        outcome.state === "fenced" ||
        !(await lockAgentOwner(
          tx,
          ref,
          command.targetSessionId,
          command.id,
          false,
        ))
      )
        return supersedeAgentMessage(tx, ref, command.id);
      if (complete)
        await recordArtifact(
          {
            id: consensusDraftArtifactId(ref.runId, source),
            runId: ref.runId,
            nodeId: "consensus-draft",
            artifactDefId: "default:consensus-draft",
            kind: "human_note",
            producer: "runner",
            locator: { kind: "inline", text },
            validity: "current",
            visibility: "internal",
            retention: "run",
          },
          tx,
        );
      application = await prepared.apply(tx);
      if (!application.finalized)
        throw new PromptOwnerInvariantError("consensus_draft_finalization");
      await acknowledgeAgentMessage(tx, ref, command.id);
      log.info(
        {
          runId: ref.runId,
          nodeAttemptId: ref.nodeAttemptId,
          round: ref.round,
          participantId: ref.participantId,
          commandId: command.id,
          status: application.status,
          complete,
        },
        "consensus-draft-result-applied",
      );

      return "applied";
    },
    afterCommit: () => prepared.afterCommit(application),
  };
}

export const consensusDraftPromptOwners: PromptOwnerRegistry =
  createAgentPromptOwners({
    prepareConsensusDraft: prepareConsensusDraftPrompt,
  });

export async function waitForConsensusDraftPrompt(
  db: Db,
  client: BoundClient,
  commandId: string,
  signal?: AbortSignal,
): Promise<void> {
  await awaitAgentApplication(db, commandId, () =>
    client.waitForPrompt(
      { commandId },
      { owners: consensusDraftPromptOwners, signal },
    ),
  );
}
