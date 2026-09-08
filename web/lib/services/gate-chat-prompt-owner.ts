import "server-only";

import type { BoundClient } from "@/lib/execution-host/client";
import type { Db as LedgerDb } from "@/lib/execution-host/db";
import type { ExecutionCommand, ExecutionEvent } from "@/lib/db/schema";
import type { PromptOwnerAdmission } from "@/lib/execution-host/ledger";
import type { PromptResult } from "@/lib/execution-host";
import type { PromptOwner } from "@/lib/execution-host/prompt-owner-contract";
import type {
  PreparedPromptOwner,
  PromptOwnerOutcome,
  PromptOwnerRegistry,
} from "@/lib/execution-host/prompt-owners";

import { and, eq } from "drizzle-orm";
import pino from "pino";

import {
  senseAndRestore,
  terminalizePendingGateChatTurn,
} from "./gate-chat-turn-completion";

import * as schemaModule from "@/lib/db/schema";
import {
  executionCommands,
  runSessionIncarnations,
  runSessions,
} from "@/lib/db/schema";
import { applyPromptOwner } from "@/lib/execution-host/prompt-owner-application";
import {
  createPromptOwnerRegistry,
  definePromptOwnerAdapter,
  PromptOwnerInvariantError,
} from "@/lib/execution-host/prompt-owners";
import {
  lockCurrentSessionAssignment,
  staleSessionBinding,
} from "@/lib/execution-host/session-binding";
import { checkpointRefName } from "@/lib/flows/graph/workspace-checkpoint";
import { MaisterError } from "@/lib/errors";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { gateChatMessages, gateChatTurns, hitlRequests, workspaces } =
  schemaModule as unknown as Record<string, any>;

// FIXME(any): dual drizzle-orm peer-dep variants.
type Db = any;

const log = pino({
  name: "gate-chat-prompt-owner",
  level: process.env.LOG_LEVEL ?? "info",
});

type GateChatRef = Extract<PromptOwner, { kind: "gate_chat" }>["ref"];

export type GateChatPromptOwner = Readonly<{
  hitlRequestId: string;
  turnId: string;
  userMessageId: string;
  /** The `gate_chat_turns.lease_expires_at` the turn was admitted under — the
   * same value the reconcile CAS uses as its generation token. */
  leaseGeneration: string;
}>;

export function gateChatPromptOperationKey(turnId: string): string {
  return `gate_chat:reply:${turnId}`;
}

export async function admitGateChatPrompt(
  tx: Db,
  client: BoundClient,
  hostSessionId: string,
  owner: GateChatPromptOwner,
): Promise<PromptOwnerAdmission> {
  const runId = client.assignment.runId;
  // The response claim takes the HITL row first; every writer here keeps that
  // order or a concurrent turn deadlocks against it.
  const [hitl] = await tx
    .select({ id: hitlRequests.id, runId: hitlRequests.runId })
    .from(hitlRequests)
    .where(eq(hitlRequests.id, owner.hitlRequestId))
    .for("update");
  const assignment = await lockCurrentSessionAssignment(tx as LedgerDb, {
    runId,
    assignmentId: client.assignment.id,
  });

  if (!assignment) throw staleSessionBinding(runId, client.assignment.id);
  const [turn] = await tx
    .select({
      id: gateChatTurns.id,
      runId: gateChatTurns.runId,
      hitlRequestId: gateChatTurns.hitlRequestId,
      userMessageId: gateChatTurns.userMessageId,
      state: gateChatTurns.state,
      leaseExpiresAt: gateChatTurns.leaseExpiresAt,
    })
    .from(gateChatTurns)
    .where(eq(gateChatTurns.id, owner.turnId))
    .for("update");

  if (
    !hitl ||
    hitl.runId !== runId ||
    !turn ||
    turn.runId !== runId ||
    turn.state !== "pending" ||
    turn.hitlRequestId !== owner.hitlRequestId ||
    turn.userMessageId !== owner.userMessageId
  )
    throw new PromptOwnerInvariantError("gate_chat_admission_generation");
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
    throw new PromptOwnerInvariantError("gate_chat_admission_incarnation");
  const ref: GateChatRef = {
    version: 1,
    variant: "reply",
    runId,
    runSessionId: binding.session.id,
    incarnationId: binding.incarnation.id,
    assignmentId: assignment.id,
    assignmentEpoch: assignment.epoch,
    hitlRequestId: owner.hitlRequestId,
    turnId: owner.turnId,
    userMessageId: owner.userMessageId,
    // The lease this turn was admitted under. Recovery legitimately EXTENDS a
    // pending turn's lease, so this is provenance, never an admission gate:
    // gating on it would refuse the very turn recovery is keeping alive.
    leaseGeneration:
      turn.leaseExpiresAt?.toISOString() ?? owner.leaseGeneration,
  };

  return {
    owner: { kind: "gate_chat", ref },
    logicalOperationKey: gateChatPromptOperationKey(owner.turnId),
  };
}

/** The live consumer prefers the accumulated `session.chat_turn` body and falls
 * back to agent message chunks; the durable span carries both, so recovery
 * reconstructs the same reply a live stack would have shown. */
function decodeReply(
  event: ExecutionEvent,
  hitlRequestId: string,
): { turn: string | null; chunk: string | null } {
  const payload = (event.payload ?? {}) as Record<string, unknown>;

  if (
    event.eventType === "session.chat_turn" &&
    payload.hitlRequestId === hitlRequestId &&
    payload.role === "agent" &&
    typeof payload.body === "string"
  )
    return { turn: payload.body, chunk: null };
  if (event.eventType === "session.update") {
    const update = payload.update as {
      sessionUpdate?: string;
      content?: { type?: string; text?: string };
    } | null;

    if (
      update?.sessionUpdate === "agent_message_chunk" &&
      update.content?.type === "text" &&
      typeof update.content.text === "string"
    )
      return { turn: null, chunk: update.content.text };
  }

  return { turn: null, chunk: null };
}

/** The L3 restore runs in `prepare`, so the workspace is durably neutral before
 * `apply` releases the pending-turn fence. A crash between them replays both. */
export async function prepareGateChatPrompt(input: {
  db: Db;
  ref: GateChatRef;
  command: Readonly<ExecutionCommand>;
  outcome: PromptOwnerOutcome;
}): Promise<PreparedPromptOwner> {
  const { db, ref, command, outcome } = input;
  let replyFromEvent: string | null = null;
  let replyChunks = "";

  if (outcome.state === "succeeded")
    for await (const event of outcome.events) {
      const decoded = decodeReply(event, ref.hitlRequestId);

      if (decoded.turn !== null) replyFromEvent = decoded.turn;
      if (decoded.chunk !== null) replyChunks += decoded.chunk;
    }
  const cancelled =
    outcome.state === "succeeded" &&
    outcome.response.stopReason === "cancelled";
  // ADR-166 E-EH-11: a fenced prompt means a newer generation owns the run. The
  // turn is that driver's to settle, so this owner writes nothing at all.
  const failure =
    outcome.state === "failed"
      ? "ACP_PROTOCOL"
      : cancelled
        ? "PROMPT_CANCELLED"
        : null;

  if (outcome.state === "fenced")
    return { apply: async () => "superseded" as const };
  const [workspace] = await db
    .select({
      worktreePath: workspaces.worktreePath,
      removedAt: workspaces.removedAt,
    })
    .from(workspaces)
    .where(eq(workspaces.runId, ref.runId))
    .limit(1);

  if (!workspace || workspace.removedAt !== null)
    throw new MaisterError(
      "CHECKPOINT",
      `gate-chat owner cannot restore workspace for run ${ref.runId}`,
    );
  const sensed = await senseAndRestore({
    worktreePath: workspace.worktreePath,
    baselineRef: checkpointRefName(
      "chat-checkpoints",
      ref.runId,
      ref.hitlRequestId,
    ),
  });

  return {
    apply: async (tx) => {
      const [lockedHitl] = await tx
        .select({
          response: hitlRequests.response,
          respondedAt: hitlRequests.respondedAt,
        })
        .from(hitlRequests)
        .where(eq(hitlRequests.id, ref.hitlRequestId))
        .for("update");
      const [turn] = await tx
        .select({
          id: gateChatTurns.id,
          state: gateChatTurns.state,
          userMessageId: gateChatTurns.userMessageId,
          leaseExpiresAt: gateChatTurns.leaseExpiresAt,
        })
        .from(gateChatTurns)
        .where(eq(gateChatTurns.id, ref.turnId))
        .for("update");

      if (
        !turn ||
        turn.state !== "pending" ||
        turn.userMessageId !== ref.userMessageId
      )
        return "superseded";
      if (failure !== null) {
        // Why the turn was cancelled is durable state, not stack knowledge: a
        // turn whose own lease has run out was cancelled BY the expiry, and any
        // process applying this outcome reaches the same conclusion.
        const expired =
          cancelled &&
          turn.leaseExpiresAt !== null &&
          turn.leaseExpiresAt.getTime() <= Date.now();

        await terminalizePendingGateChatTurn(tx, {
          turnId: ref.turnId,
          hitlRequestId: ref.hitlRequestId,
          errorCode: expired ? "LEASE_EXPIRED" : failure,
          ...(cancelled ? { terminalState: "aborted" as const } : {}),
        });

        return "applied";
      }
      // A claimed response ends the thread: the reply can never be shown, and
      // leaving the turn pending would block chat admission forever.
      if (
        !lockedHitl ||
        lockedHitl.response !== null ||
        lockedHitl.respondedAt !== null
      ) {
        await terminalizePendingGateChatTurn(tx, {
          turnId: ref.turnId,
          hitlRequestId: ref.hitlRequestId,
          errorCode: "RESPONSE_CLAIMED",
          terminalState: "aborted",
        });

        return "superseded";
      }
      const [userMessage] = await tx
        .select({
          seq: gateChatMessages.seq,
          nodeId: gateChatMessages.nodeId,
          gateAttempt: gateChatMessages.gateAttempt,
          acpSessionId: gateChatMessages.acpSessionId,
        })
        .from(gateChatMessages)
        .where(eq(gateChatMessages.id, ref.userMessageId));

      if (!userMessage)
        throw new PromptOwnerInvariantError("gate_chat_user_message");
      const body = replyFromEvent ?? replyChunks;
      const [stored] = await tx
        .insert(gateChatMessages)
        .values({
          runId: ref.runId,
          hitlRequestId: ref.hitlRequestId,
          nodeId: userMessage.nodeId,
          gateAttempt: userMessage.gateAttempt,
          role: "agent",
          authorUserId: null,
          authorLabel: "agent",
          body,
          acpSessionId: userMessage.acpSessionId,
          seq: userMessage.seq + 1,
          mutationReverted: sensed.reverted,
        })
        .returning({ id: gateChatMessages.id });

      if (!stored) throw new PromptOwnerInvariantError("gate_chat_agent_row");
      await tx
        .update(gateChatTurns)
        .set({
          state: "completed",
          agentMessageId: stored.id,
          leaseExpiresAt: null,
          completedAt: new Date(),
        })
        .where(
          and(
            eq(gateChatTurns.id, ref.turnId),
            eq(gateChatTurns.state, "pending"),
          ),
        );
      log.info(
        {
          runId: ref.runId,
          turnId: ref.turnId,
          commandId: command.id,
          reverted: sensed.reverted,
          replyLen: body.length,
        },
        "gate-chat-reply-applied",
      );

      return "applied";
    },
  };
}

export const gateChatPromptOwners: PromptOwnerRegistry =
  createPromptOwnerRegistry([
    definePromptOwnerAdapter("gate_chat", async (context) =>
      prepareGateChatPrompt({ ...context, ref: context.owner.ref }),
    ),
  ]);

/** Evidence first: an expired lease is not evidence that the turn failed. If
 * this turn's own command already carries a durable outcome, apply it — the
 * reply and its L3 restore land through the same owner path a live caller uses
 * — instead of aborting the turn with LEASE_EXPIRED. A command still in flight
 * is not claimable and defers, so the caller falls through to cancellation. */
export async function reconcileOwnedGateChatTurn(
  db: Db,
  turnId: string,
  signal: AbortSignal,
): Promise<boolean> {
  const [command] = await db
    .select({ id: executionCommands.id })
    .from(executionCommands)
    .where(
      and(
        eq(executionCommands.ownerKind, "gate_chat"),
        eq(
          executionCommands.logicalOperationKey,
          gateChatPromptOperationKey(turnId),
        ),
      ),
    );

  if (!command) return false;
  const outcome = await applyPromptOwner({
    db,
    owners: gateChatPromptOwners,
    commandId: command.id,
    signal,
  });

  log.info(
    { turnId, commandId: command.id, outcome },
    "gate-chat-owner-reconciled",
  );

  return outcome === "applied";
}

/** The reply the owner committed. Both the live caller and a later reader see
 * exactly the same row; nothing is reconstructed from a stack that may be gone. */
export async function loadAppliedGateChatReply(
  db: Db,
  turnId: string,
): Promise<(GateChatReplyView & { mutationReverted: boolean }) | null> {
  const [row] = await db
    .select({
      state: gateChatTurns.state,
      message: gateChatMessages,
    })
    .from(gateChatTurns)
    .innerJoin(
      gateChatMessages,
      eq(gateChatMessages.id, gateChatTurns.agentMessageId),
    )
    .where(eq(gateChatTurns.id, turnId));

  if (!row || row.state !== "completed") return null;

  return {
    id: row.message.id,
    role: "agent",
    authorLabel: row.message.authorLabel ?? "agent",
    body: row.message.body,
    seq: row.message.seq,
    mutationReverted: row.message.mutationReverted ?? false,
    createdAt: row.message.createdAt,
  };
}

export type GateChatReplyView = Readonly<{
  id: string;
  role: "agent";
  authorLabel: string;
  body: string;
  seq: number;
  createdAt: Date;
}>;

/** Returns the live prompt result, or null when the owner already settled this
 * command durably and there is no live outcome to report. */
export async function waitForGateChatPrompt(
  db: Db,
  client: BoundClient,
  handle: { commandId: string },
  signal?: AbortSignal,
): Promise<PromptResult | null> {
  const commandId = handle.commandId;

  try {
    return await client.waitForPrompt(handle, {
      owners: gateChatPromptOwners,
      signal,
    });
  } catch (cause) {
    const [row] = await db
      .select({
        state: executionCommands.state,
        applicationState: executionCommands.applicationState,
      })
      .from(executionCommands)
      .where(eq(executionCommands.id, commandId));

    // A settled owner means the DOMAIN transition is durable; it does not turn
    // a failed turn into a successful one. Only a successful command may be
    // swallowed here — a definitive failure still owes the caller its rejection.
    // Only a command that SUCCEEDED and settled has nothing left to report.
    // Every other outcome keeps its original error: the caller branches on a
    // fenced turn, and a failed one still owes its terminalization.
    if (
      row?.state === "succeeded" &&
      (row.applicationState === "applied" ||
        row.applicationState === "superseded")
    )
      return null;
    // A fenced command belongs to a newer generation. The owner machinery
    // refuses to apply against a released assignment, and that refusal must not
    // masquerade as this turn's failure — callers branch on the fence.
    if (row?.state === "fenced")
      throw new MaisterError(
        "CONFLICT",
        "gate-chat turn was fenced by a newer generation",
        { details: { reason: "assignment_fenced" } },
      );
    throw cause;
  }
}
