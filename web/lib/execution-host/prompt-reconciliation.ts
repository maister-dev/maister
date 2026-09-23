import "server-only";

import type { Logger } from "pino";
import type { Db } from "./db";
import type { CommandReceipt } from "./contracts";
import type { PromptEvidenceResult } from "./prompt-evidence";

import { and, eq, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import pino from "pino";

import { getCommand } from "./commands";
import {
  depositPromptReceipt,
  quarantinePromptProtocol,
  reconcileStoredPromptEvidence,
  reduceHostSpanEvidence,
} from "./prompt-evidence";
import { HostSpanSignals, verifyHostPromptSpan } from "./prompt-output";
import { HostSpanUnavailable } from "./prompt-host-span";
import {
  classifyPromptTransportFailure,
  isPromptProtocolConflict,
} from "./prompt-transport";
import { OPEN_COMMAND_STATES } from "./types";

import { executionCommands, executionEventStreams } from "@/lib/db/schema";
import { isMaisterError } from "@/lib/errors";

const log = pino({
  name: "prompt-reconciliation",
  level: process.env.LOG_LEVEL ?? "info",
});
const RECEIPT_CLAIM_MS = 30_000;
const RECEIPT_RETRY_MS = 5_000;

export type PromptReconciliationResult = PromptEvidenceResult & {
  receiptRead: "not_due" | "missing" | "present" | "unavailable";
};

/** Query, wait and restart recovery acquire the same bounded receipt-read
 * claim. The due timestamp is a CAS token; a late read cannot overwrite a
 * successor claim or independently ingested evidence. No outbound prompt is
 * sent here and a missing/unreachable receipt never terminalizes execution.
 */
export async function reconcilePromptCommand(input: {
  db: Db;
  commandId: string;
  signal?: AbortSignal;
  lookupReceipt?: (id: string) => Promise<CommandReceipt | null>;
  now?: () => Date;
  logger?: Logger;
}): Promise<PromptReconciliationResult> {
  const signal = input.signal ?? AbortSignal.timeout(30_000);
  const existing = await reconcileStoredPromptEvidence(
    input.db,
    input.commandId,
    signal,
  );
  const row = existing.command;

  if (existing.disposition !== "waiting")
    return { ...existing, receiptRead: "not_due" };
  // Explicit preflight evidence is the only terminal path without host events.
  if (
    row.state === "failed" &&
    row.lastError?.details &&
    typeof row.lastError.details === "object" &&
    "transport" in row.lastError.details &&
    row.lastError.details.transport === "not_sent"
  )
    return { disposition: "settled", command: row, receiptRead: "not_due" };
  // Host reads are for callers that may reach the host (they pass a receipt
  // lookup); a DB-only query never triggers one.
  if (!input.lookupReceipt) return { ...existing, receiptRead: "not_due" };
  const now = input.now ?? (() => new Date());

  if (row.receiptEvidence)
    return {
      ...(await settleFromHostSpanWhenDue(input.db, row.id, signal, now)),
      receiptRead: "not_due",
    };
  const at = now();
  const claimUntil = new Date(at.getTime() + RECEIPT_CLAIM_MS);
  const [claimed] = await input.db
    .update(executionCommands)
    .set({ nextAttemptAt: claimUntil })
    .where(
      and(
        eq(executionCommands.id, row.id),
        inArray(executionCommands.state, [...OPEN_COMMAND_STATES]),
        isNull(executionCommands.receiptEvidence),
        or(
          isNull(executionCommands.nextAttemptAt),
          lte(executionCommands.nextAttemptAt, at),
        ),
      ),
    )
    .returning({ id: executionCommands.id });

  if (!claimed) return { ...existing, receiptRead: "not_due" };
  let receipt: CommandReceipt | null = null;
  let receiptRead: PromptReconciliationResult["receiptRead"] = "missing";

  try {
    receipt = await input.lookupReceipt(row.id);
    if (receipt) receiptRead = "present";
  } catch (error) {
    receiptRead = "unavailable";
    if (isPromptProtocolConflict(error))
      return {
        ...(await quarantinePromptProtocol(input.db, row.id, "receipt")),
        receiptRead,
      };
    const failure = classifyPromptTransportFailure(error);

    (input.logger ?? log).warn(
      { commandId: row.id, ...failure },
      "prompt-receipt-unavailable",
    );
    if (failure.disposition !== "retry") throw error;
  }
  if (receipt) {
    const deposited = await depositPromptReceipt(input.db, row.id, receipt);

    if (deposited.disposition === "quarantined")
      return { ...deposited, receiptRead };
    // First attempt inside this claim, without waiting out the retry delay:
    // the direct binding, then the host's span (ADR-167 D5 amendment, D-B5).
    const bound = await reconcileStoredPromptEvidence(input.db, row.id, signal);

    if (bound.disposition === "waiting")
      await attemptHostSpan(input.db, row.id, signal, now);
  }
  await input.db
    .update(executionCommands)
    .set({
      nextAttemptAt: new Date(now().getTime() + RECEIPT_RETRY_MS),
      transportState: sql`CASE WHEN ${executionCommands.transportState} = 'acknowledged' THEN 'acknowledged'
      WHEN ${executionCommands.attempts} >= ${executionCommands.maxAttempts} THEN 'reconciliation_required'
      ELSE ${executionCommands.transportState} END`,
    })
    .where(
      and(
        eq(executionCommands.id, row.id),
        eq(executionCommands.nextAttemptAt, claimUntil),
        inArray(executionCommands.state, [...OPEN_COMMAND_STATES]),
      ),
    );

  return {
    ...(await reconcileStoredPromptEvidence(input.db, row.id, signal)),
    receiptRead,
  };
}

/** A completed receipt with no ingested terminal event: claim the row the way
 * the receipt read does (the same column and constants), so one waiter per
 * ~5 s reads the host span however many wake at 4 Hz. */
async function settleFromHostSpanWhenDue(
  db: Db,
  commandId: string,
  signal: AbortSignal,
  now: () => Date,
): Promise<PromptEvidenceResult> {
  const pending = await getCommand(db, commandId);

  // Failed and fenced receipts carry no output manifest, so no bounded span
  // proves them signal-free: they settle canonically (D-B4 scope).
  if (pending?.receiptEvidence?.evidenceV2?.phase !== "completed")
    return reconcileStoredPromptEvidence(db, commandId, signal);
  const at = now();
  const claimUntil = new Date(at.getTime() + RECEIPT_CLAIM_MS);
  const [claimed] = await db
    .update(executionCommands)
    .set({ nextAttemptAt: claimUntil })
    .where(
      and(
        eq(executionCommands.id, commandId),
        eq(executionCommands.kind, "session.prompt"),
        inArray(executionCommands.state, [...OPEN_COMMAND_STATES]),
        isNotNull(executionCommands.receiptEvidence),
        isNull(executionCommands.terminalEvidenceSha256),
        or(
          isNull(executionCommands.nextAttemptAt),
          lte(executionCommands.nextAttemptAt, at),
        ),
      ),
    )
    .returning({ id: executionCommands.id });

  if (!claimed) return reconcileStoredPromptEvidence(db, commandId, signal);
  const settled = await attemptHostSpan(db, commandId, signal, now);

  await db
    .update(executionCommands)
    .set({ nextAttemptAt: new Date(now().getTime() + RECEIPT_RETRY_MS) })
    .where(
      and(
        eq(executionCommands.id, commandId),
        eq(executionCommands.nextAttemptAt, claimUntil),
        inArray(executionCommands.state, [...OPEN_COMMAND_STATES]),
      ),
    );

  return settled ?? reconcileStoredPromptEvidence(db, commandId, signal);
}

/** One host-span attempt under a held claim. A span that is unreadable,
 * unverifiable or signal-bearing is never evidence against the command: the
 * command keeps waiting for the canonical feed. */
async function attemptHostSpan(
  db: Db,
  commandId: string,
  signal: AbortSignal,
  now: () => Date,
): Promise<PromptEvidenceResult | null> {
  const command = await getCommand(db, commandId);

  if (!command || command.terminalEvidenceSha256) return null;
  const receipt = command.receiptEvidence?.evidenceV2;

  if (receipt?.phase !== "completed" || !receipt.terminal) {
    log.debug(
      { commandId, feed: "canonical", reason: "receipt_not_completed" },
      "prompt-evidence-feed-selected",
    );

    return null;
  }
  let terminal;

  try {
    terminal = await verifyHostPromptSpan({ db, command, signal });
  } catch (error) {
    if (signal.aborted) throw error;
    if (error instanceof HostSpanSignals) {
      log.debug(
        { commandId, feed: "none", reason: "span_has_signal_events" },
        "prompt-evidence-feed-selected",
      );

      return null;
    }
    if (error instanceof HostSpanUnavailable)
      log.warn(
        { commandId, reason: error.reason },
        "prompt-host-span-unavailable",
      );
    else
      log.warn(
        {
          commandId,
          causeCode: isMaisterError(error)
            ? String(error.details?.causeCode ?? error.code)
            : error instanceof Error
              ? error.name
              : "unknown",
        },
        "prompt-host-span-unverified",
      );

    return null;
  }
  log.debug(
    { commandId, feed: "host_span", reason: "span_verified" },
    "prompt-evidence-feed-selected",
  );
  let result;

  try {
    result = await reduceHostSpanEvidence(db, commandId, terminal);
  } catch (error) {
    if (signal.aborted) throw error;
    // A failed fast-feed write is no more evidence than an unreadable span:
    // the canonical feed still settles the command. Surface it here, because
    // a flow wait turns any thrown error into a cause-less continuation yield.
    const sqlState = (error as { code?: unknown } | null)?.code;

    log.warn(
      {
        commandId,
        causeCode:
          typeof sqlState === "string"
            ? sqlState
            : error instanceof Error
              ? error.name
              : "unknown",
      },
      "prompt-host-span-settlement-failed",
    );

    return null;
  }

  if (result.settledHere) {
    const [stream] = terminal.eventStreamId
      ? await db
          .select({ last: executionEventStreams.lastContiguousSequence })
          .from(executionEventStreams)
          .where(eq(executionEventStreams.id, terminal.eventStreamId))
      : [];

    log.warn(
      {
        commandId,
        runId: command.runId,
        hostId: command.executionHostId,
        lagEvents: String(
          BigInt(receipt.terminal.sequence) - (stream?.last ?? -1n),
        ),
        lagMs: now().getTime() - Date.parse(receipt.receivedAt),
      },
      "prompt-settled-from-host-span",
    );
  }

  return result;
}
