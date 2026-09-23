import "server-only";

import type { Db } from "./db";
import type { CommandReceipt } from "./contracts";
import type { ExecutionCommand, ExecutionEvent } from "@/lib/db/schema";

import { createHash } from "node:crypto";

import { and, count, eq, gte, inArray, lte } from "drizzle-orm";
import pino from "pino";

import {
  canonicalCommandJson,
  CommandJsonError,
} from "../../../runtime/command-json";
import {
  CommandEvidenceError,
  parseCommandOutputReferenceV2,
  parseCommandReceiptV2,
  parseCommandEventPayloadV2,
} from "../../../runtime/command-evidence";

import { COMMAND_REQUEST_SCHEMA, readPromptRequest } from "./command-request";
import { normalizeCommandReceiptV2 } from "./command-receipt";
import { casTransition, getCommand } from "./commands";
import { commandSignals } from "./signals";
import { preparePromptContent } from "./events/session-content";
import { reanchorDispatchedPrompts } from "./events/run-message-store";
import { CONSUMER_SIGNAL_EVENT_TYPES } from "./prompt-signal-events";

import {
  executionCommands,
  executionEvents,
  executionHosts,
  executionEventStreams,
} from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";

const log = pino({
  name: "prompt-evidence",
  level: process.env.LOG_LEVEL ?? "info",
});

export type PromptEvidenceDisposition = "waiting" | "settled" | "quarantined";
/** Which evidence settled a prompt first: the ingested canonical terminal
 * event, or the host's verified event span (ADR-167 D5 amendment). */
export type PromptEvidenceFeed = "canonical" | "host_span";
export type TerminalEvidence = Readonly<{
  feed: PromptEvidenceFeed;
  event: ExecutionEvent;
}>;
export type PromptEvidenceResult = {
  disposition: PromptEvidenceDisposition;
  command: ExecutionCommand;
};

type TerminalOutcome = {
  status: "succeeded" | "failed" | "fenced";
  result: Record<string, unknown> | null;
  error: Record<string, unknown> | null;
};

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function outcomeFromEvent(event: ExecutionEvent): TerminalOutcome | null {
  const payload = event.payload;

  if (event.payloadSchema === "maister.session.command.v2") {
    const terminal = payload?.terminal;

    if (!record(terminal)) return null;
    if (
      terminal.status === "succeeded" &&
      record(terminal.result) &&
      terminal.error === null
    )
      return { status: "succeeded", result: terminal.result, error: null };
    if (
      (terminal.status === "failed" || terminal.status === "fenced") &&
      record(terminal.error) &&
      terminal.result === null
    )
      return { status: terminal.status, result: null, error: terminal.error };

    return null;
  }
  if (!payload || payload.phase !== "completed") return null;
  if (payload.status === "succeeded") {
    if (
      !record(payload.result) ||
      typeof payload.result.stopReason !== "string" ||
      payload.error !== undefined
    )
      return null;

    return { status: "succeeded", result: payload.result, error: null };
  }
  if (payload.status !== "failed" && payload.status !== "fenced") return null;
  if (
    !record(payload.error) ||
    typeof payload.error.code !== "string" ||
    typeof payload.error.message !== "string" ||
    payload.result !== undefined
  )
    return null;

  return { status: payload.status, result: null, error: payload.error };
}

function outcomeFromReceipt(receipt: CommandReceipt): TerminalOutcome | null {
  if (receipt.phase === "accepted") return null;
  if (!record(receipt.body)) return null;
  if (receipt.phase === "completed") {
    if (
      receipt.httpStatus >= 400 ||
      typeof receipt.body.stopReason !== "string"
    )
      return null;

    return { status: "succeeded", result: receipt.body, error: null };
  }
  if (
    receipt.httpStatus < 400 ||
    typeof receipt.body.code !== "string" ||
    typeof receipt.body.message !== "string"
  )
    return null;

  return {
    status: receipt.body.code === "FENCED" ? "fenced" : "failed",
    result: null,
    error: receipt.body,
  };
}

function sameJson(left: unknown, right: unknown): boolean {
  try {
    return canonicalCommandJson(left) === canonicalCommandJson(right);
  } catch (error) {
    if (error instanceof CommandJsonError) return false;
    throw error;
  }
}

export function promptEvidenceConflict(commandId: string): MaisterError {
  return new MaisterError(
    "CONFLICT",
    "prompt terminal evidence failed its identity or agreement check",
    {
      details: { reason: "prompt_terminal_conflict", commandId },
    },
  );
}

async function lockPrompt(
  tx: Db,
  commandId: string,
): Promise<ExecutionCommand> {
  const [row] = await tx
    .select()
    .from(executionCommands)
    .where(eq(executionCommands.id, commandId))
    .for("update")
    .limit(1);

  if (!row || row.kind !== "session.prompt")
    throw new MaisterError("PRECONDITION", "prompt command is not available", {
      details: { reason: "prompt_command_missing", commandId },
    });

  return row;
}

async function quarantine(
  tx: Db,
  command: ExecutionCommand,
  invariant: string,
): Promise<PromptEvidenceResult> {
  const [row] = await tx
    .update(executionCommands)
    .set({
      applicationState: command.completionAppliedAt ? "applied" : "poisoned",
      applicationClaimOwner: null,
      applicationClaimExpiresAt: null,
      applicationNextRetryAt: null,
      applicationError: {
        reason: "prompt_terminal_conflict",
        phase: "prepare",
        causeCode: invariant,
      },
      updatedAt: new Date(),
    })
    .where(eq(executionCommands.id, command.id))
    .returning();

  log.error(
    { commandId: command.id, invariant },
    "prompt-evidence-quarantined",
  );

  return { disposition: "quarantined", command: row };
}

/** Invalid wire evidence is a durable application quarantine, never a guessed
 * execution failure. The discriminator contains no untrusted response body.
 */
export async function quarantinePromptProtocol(
  db: Db,
  commandId: string,
  source: "admission" | "receipt",
): Promise<PromptEvidenceResult> {
  const result = await db.transaction(async (tx) =>
    quarantine(tx, await lockPrompt(tx, commandId), `${source}_protocol`),
  );

  commandSignals.wake(commandId);

  return result;
}

async function receiptMatches(
  tx: Db,
  command: ExecutionCommand,
  receipt: CommandReceipt,
): Promise<boolean> {
  if (
    receipt.commandId !== command.id ||
    receipt.kind !== command.kind ||
    receipt.runId !== command.runId ||
    receipt.assignmentEpoch !== command.assignmentEpoch
  )
    return false;
  if (command.requestSchema !== COMMAND_REQUEST_SCHEMA)
    return receipt.evidenceV2 === undefined;
  if (!receipt.evidenceV2) return false;
  const [host] = await tx
    .select({ hostKey: executionHosts.hostKey })
    .from(executionHosts)
    .where(eq(executionHosts.id, command.executionHostId))
    .limit(1);

  if (!host) return false;
  try {
    const evidence = parseCommandReceiptV2(receipt.evidenceV2);
    const request = readPromptRequest(command, host.hostKey);

    return (
      evidence.hostKey === request.fence.hostKey &&
      evidence.assignmentId === request.fence.assignmentId &&
      evidence.hostSessionId === request.target.hostSessionId &&
      evidence.requestSchema === command.requestSchema &&
      evidence.requestSha256 === command.requestSha256 &&
      sameJson(receipt, normalizeCommandReceiptV2(evidence))
    );
  } catch (error) {
    if (error instanceof CommandEvidenceError || error instanceof MaisterError)
      return false;
    throw error;
  }
}

function eventMatches(
  command: ExecutionCommand,
  event: ExecutionEvent,
): boolean {
  return (
    (command.requestSchema !== COMMAND_REQUEST_SCHEMA ||
      (event.payloadSchema === "maister.session.command.v2" &&
        event.payload?.requestSchema === command.requestSchema &&
        event.payload.requestSha256 === command.requestSha256)) &&
    event.source === "host" &&
    event.ingestDisposition === "accepted" &&
    event.eventType === "session.command" &&
    event.payload?.kind === "session.prompt" &&
    event.payload.commandId === command.id &&
    event.runId === command.runId &&
    event.executionHostId === command.executionHostId &&
    event.executionAssignmentId === command.executionAssignmentId &&
    event.assignmentEpoch === command.assignmentEpoch &&
    (command.targetSessionId === null ||
      event.hostSessionId === command.targetSessionId)
  );
}

/** The only canonical prompt terminal writer. The row lock, exact event
 * identity, independently stored receipt and result transition share one DB
 * transaction. Pending evidence never becomes a domain execution failure.
 */
async function reducePromptEvidence(
  tx: Db,
  command: ExecutionCommand,
  evidence: TerminalEvidence | null,
): Promise<PromptEvidenceResult> {
  if (command.applicationError?.reason === "prompt_terminal_conflict")
    return { disposition: "quarantined", command };
  if (!evidence || !command.receiptEvidence)
    return { disposition: "waiting", command };
  const { event, feed } = evidence;

  // The only feed-dependent check: a canonical event is bound to the command
  // before it reduces; host-span evidence settles with no event row to bind,
  // and is confirmed when the canonical event later binds the same identity.
  if (
    !eventMatches(command, event) ||
    command.receiptEvidence.eventId !== event.id ||
    (command.terminalEventId === null
      ? feed === "canonical"
      : command.terminalEventId !== event.id)
  )
    return quarantine(tx, command, "terminal_identity");
  if (!(await receiptMatches(tx, command, command.receiptEvidence)))
    return quarantine(tx, command, "receipt_binding");
  const v2 = command.receiptEvidence.evidenceV2;

  if (v2) {
    const [stream] = event.eventStreamId
      ? await tx
          .select()
          .from(executionEventStreams)
          .where(eq(executionEventStreams.id, event.eventStreamId))
          .limit(1)
      : [];

    if (
      !stream ||
      stream.executionHostId !== command.executionHostId ||
      stream.streamId !== v2.terminal?.streamId ||
      event.hostSequence?.toString() !== v2.terminal.sequence ||
      event.payload?.sourceCommandId !== command.id
    )
      return quarantine(tx, command, "terminal_stream_binding");
    try {
      const payload = parseCommandEventPayloadV2(event.payload, {
        eventId: event.id,
        streamId: stream.streamId,
        sequence: event.hostSequence!.toString(),
        hostSessionId: event.hostSessionId,
      });

      if (!sameJson(payload.terminal, v2.terminal))
        return quarantine(tx, command, "terminal_v2_agreement");
    } catch (error) {
      if (error instanceof CommandEvidenceError)
        return quarantine(tx, command, "terminal_v2_shape");
      throw error;
    }
  }
  const outcome = outcomeFromEvent(event);
  const receiptOutcome = outcomeFromReceipt(command.receiptEvidence);

  if (!outcome || !receiptOutcome || !sameJson(outcome, receiptOutcome))
    return quarantine(tx, command, "terminal_outcome");
  const digest = createHash("sha256")
    .update(
      canonicalCommandJson(
        v2
          ? {
              commandId: v2.commandId,
              kind: v2.kind,
              hostKey: v2.hostKey,
              runId: v2.runId,
              assignmentId: v2.assignmentId,
              assignmentEpoch: v2.assignmentEpoch,
              hostSessionId: v2.hostSessionId,
              requestSchema: v2.requestSchema,
              requestSha256: v2.requestSha256,
              ...v2.terminal,
            }
          : {
              outcomeVersion: 1,
              commandId: command.id,
              runId: command.runId,
              executionHostId: command.executionHostId,
              assignmentId: command.executionAssignmentId,
              assignmentEpoch: command.assignmentEpoch,
              hostSessionId: event.hostSessionId,
              eventId: event.id,
              streamId: event.eventStreamId,
              sequence: event.hostSequence?.toString(),
              ...outcome,
            },
      ),
      "utf8",
    )
    .digest("hex");
  const terminal = ["succeeded", "failed", "fenced"].includes(command.state);

  if (
    command.terminalEvidenceSha256 &&
    command.terminalEvidenceSha256 !== digest
  )
    return quarantine(tx, command, "terminal_digest");
  if (
    terminal &&
    !sameJson(
      {
        status: command.state,
        result: command.result,
        error: command.lastError,
      },
      outcome,
    )
  )
    return quarantine(tx, command, "terminal_state");
  const [row] = await tx
    .update(executionCommands)
    .set({
      state: outcome.status,
      result: outcome.result,
      lastError: outcome.error,
      completedAt: command.completedAt ?? new Date(),
      terminalEvidenceSha256: digest,
      // Recorded once, by the feed that settled first; a confirming re-reduce
      // never rewrites it (the evidence trigger refuses a change).
      ...(command.terminalEvidenceSha256 ? {} : { settledFrom: feed }),
      transportState: "acknowledged",
      nextAttemptAt: null,
      updatedAt: new Date(),
    })
    .where(eq(executionCommands.id, command.id))
    .returning();

  log.debug(
    {
      commandId: row.id,
      eventId: event.id,
      digest,
      status: outcome.status,
      feed,
      settledFrom: row.settledFrom,
    },
    "prompt-evidence-agreed",
  );

  return { disposition: "settled", command: row };
}

/** Called by the DB-only projector with content verified during preparation. */
export async function recordPromptEvent(
  tx: Db,
  event: ExecutionEvent,
): Promise<PromptEvidenceResult> {
  const commandId = event.payload?.commandId;

  if (typeof commandId !== "string")
    throw new MaisterError(
      "ACP_PROTOCOL",
      "prompt event has no command identity",
    );
  const command = await lockPrompt(tx, commandId);

  if (!eventMatches(command, event))
    return quarantine(tx, command, "event_binding");
  if (event.payload?.phase === "accepted") {
    await casTransition(tx, command.id, ["queued", "delivering"], null, {
      state: "accepted",
      acceptedAt: command.acceptedAt ?? event.occurredAt,
      transportState: "acknowledged",
    });

    return {
      disposition: "waiting",
      command: (await getCommand(tx, command.id))!,
    };
  }
  const bound = await bindTerminalEvent(tx, command, event);

  if ("refused" in bound) return bound.refused;

  return reducePromptEvidence(tx, bound.command, { feed: "canonical", event });
}

/** The single writer of `terminal_event_id`: the exact canonical terminal
 * event of this command, never a replacement. Shared by the prompt projector
 * and the reconciler's direct binding, under the same row lock. */
async function bindTerminalEvent(
  tx: Db,
  command: ExecutionCommand,
  event: ExecutionEvent,
): Promise<{ command: ExecutionCommand } | { refused: PromptEvidenceResult }> {
  if (!eventMatches(command, event))
    return { refused: await quarantine(tx, command, "event_binding") };
  if (!outcomeFromEvent(event))
    return { refused: await quarantine(tx, command, "event_shape") };
  if (command.terminalEventId === event.id) return { command };
  if (command.terminalEventId)
    return { refused: await quarantine(tx, command, "event_replacement") };
  const [stored] = await tx
    .update(executionCommands)
    .set({ terminalEventId: event.id })
    .where(eq(executionCommands.id, command.id))
    .returning();

  if (command.settledFrom === "host_span") {
    log.info(
      { commandId: command.id, eventId: event.id },
      "prompt-host-span-confirmed",
    );
    if (event.runSequence !== null && command.completedAt) {
      const rows = await reanchorDispatchedPrompts(tx, {
        runId: command.runId,
        settledAt: command.completedAt,
        anchor: event.runSequence,
      });

      if (rows > 0)
        log.info(
          {
            runId: command.runId,
            commandId: command.id,
            anchor: event.runSequence.toString(),
            rows,
          },
          "transcript-prompts-reanchored",
        );
    }
  }

  return { command: stored };
}

/** ADR-167 D5 amendment (D-B5): settle from the host's verified span. The
 * reducer runs byte for byte as for the canonical event; only the identity
 * bind differs, and `settled_from` records `host_span`. */
export async function reduceHostSpanEvidence(
  db: Db,
  commandId: string,
  terminal: ExecutionEvent,
): Promise<PromptEvidenceResult & { settledHere: boolean }> {
  const result = await db.transaction(async (tx) => {
    const locked = await lockPrompt(tx, commandId);

    // The canonical feed or the direct binding won the race: nothing to add.
    if (locked.terminalEvidenceSha256)
      return {
        disposition: "settled" as const,
        command: locked,
        settledHere: false,
      };
    const reduced = await reducePromptEvidence(tx, locked, {
      feed: "host_span",
      event: terminal,
    });

    return { ...reduced, settledHere: reduced.disposition === "settled" };
  });

  if (result.disposition !== "waiting") commandSignals.wake(commandId);

  return result;
}

/** The canonical terminal event a completed v2 receipt names, when a fast feed
 * may settle from it: only a `completed` receipt with an output manifest
 * bounds the turn's span, which the signal-free rule needs. */
function receiptSpan(command: ExecutionCommand): {
  eventId: string;
  acceptedSequence: bigint;
  terminalSequence: bigint;
} | null {
  const v2 = command.receiptEvidence?.evidenceV2;

  if (!v2 || v2.phase !== "completed" || !v2.terminal) return null;
  try {
    const reference = parseCommandOutputReferenceV2(v2.terminal.result?.output);

    return {
      eventId: v2.terminal.eventId,
      acceptedSequence: BigInt(reference.acceptedSequence),
      terminalSequence: BigInt(reference.terminalSequence),
    };
  } catch (error) {
    if (error instanceof CommandEvidenceError) return null;
    throw error;
  }
}

/** A fast feed settles a turn only when its own span holds none of the events
 * the live flow consumer reacts to; such a span keeps the canonical path. */
async function spanHasConsumerSignals(
  db: Db,
  command: ExecutionCommand,
  terminal: ExecutionEvent,
  span: { acceptedSequence: bigint; terminalSequence: bigint },
): Promise<boolean> {
  if (!terminal.eventStreamId || !command.targetSessionId) return true;
  const [row] = await db
    .select({ n: count() })
    .from(executionEvents)
    .where(
      and(
        eq(executionEvents.eventStreamId, terminal.eventStreamId),
        gte(executionEvents.hostSequence, span.acceptedSequence),
        lte(executionEvents.hostSequence, span.terminalSequence),
        eq(executionEvents.hostSessionId, command.targetSessionId),
        inArray(executionEvents.eventType, [...CONSUMER_SIGNAL_EVENT_TYPES]),
      ),
    );

  return Number(row?.n ?? 0) > 0;
}

/** Receipt acquisition is outside this transaction. Only terminal evidence
 * is retained; process-local inflight state cannot change its identity.
 */
export async function depositPromptReceipt(
  db: Db,
  commandId: string,
  receipt: CommandReceipt,
): Promise<PromptEvidenceResult> {
  const result = await db.transaction(async (tx) => {
    const command = await lockPrompt(tx, commandId);

    if (!(await receiptMatches(tx, command, receipt)))
      return quarantine(tx, command, "receipt_binding");
    if (receipt.phase === "accepted") {
      await casTransition(tx, command.id, ["queued", "delivering"], null, {
        state: "accepted",
        acceptedAt: command.acceptedAt ?? new Date(),
        transportState: "acknowledged",
      });

      return {
        disposition: "waiting" as const,
        command: (await getCommand(tx, command.id))!,
      };
    }
    if (!outcomeFromReceipt(receipt))
      return quarantine(tx, command, "receipt_shape");
    const evidence: CommandReceipt = { ...receipt, inflight: false };

    if (command.receiptEvidence && !sameJson(command.receiptEvidence, evidence))
      return quarantine(tx, command, "receipt_replacement");
    const [stored] = await tx
      .update(executionCommands)
      .set({ receiptEvidence: evidence, transportState: "acknowledged" })
      .where(eq(executionCommands.id, commandId))
      .returning();

    return { disposition: "waiting" as const, command: stored };
  });

  commandSignals.wake(commandId);

  return result;
}

/** Recovery and waiters re-enter the same reducer. Required host content is
 * loaded before the transaction; the projector never performs host I/O.
 */
export async function reconcileStoredPromptEvidence(
  db: Db,
  commandId: string,
  signal: AbortSignal,
): Promise<PromptEvidenceResult> {
  const command = await getCommand(db, commandId);

  if (!command || command.kind !== "session.prompt")
    throw new MaisterError("PRECONDITION", "prompt command is not available", {
      details: { reason: "prompt_command_missing", commandId },
    });
  if (command.applicationError?.reason === "prompt_terminal_conflict")
    return { disposition: "quarantined", command };
  if (command.terminalEvidenceSha256)
    return { disposition: "settled", command };
  // Direct binding: the receipt names its canonical terminal event, so an
  // ingested event settles here without waiting for the prompt projector.
  const span = command.terminalEventId ? null : receiptSpan(command);
  const eventId = command.terminalEventId ?? span?.eventId ?? null;
  const [candidate] = eventId
    ? await db
        .select()
        .from(executionEvents)
        .where(eq(executionEvents.id, eventId))
        .limit(1)
    : [];
  const event =
    candidate &&
    span &&
    (candidate.ingestDisposition !== "accepted" ||
      (await spanHasConsumerSignals(db, command, candidate, span)))
      ? undefined
      : candidate;
  const prepared = event ? await preparePromptContent(db, event, signal) : null;
  const result = await db.transaction(async (tx) => {
    const locked = await lockPrompt(tx, commandId);

    if (!prepared) return reducePromptEvidence(tx, locked, null);
    if (locked.terminalEventId === null) {
      const bound = await bindTerminalEvent(tx, locked, prepared);

      if ("refused" in bound) return bound.refused;
      log.info(
        { commandId, eventId: prepared.id },
        "prompt-terminal-bound-directly",
      );

      return reducePromptEvidence(tx, bound.command, {
        feed: "canonical",
        event: prepared,
      });
    }

    return reducePromptEvidence(tx, locked, {
      feed: "canonical",
      event: prepared,
    });
  });

  if (result.disposition !== "waiting") commandSignals.wake(commandId);

  return result;
}
