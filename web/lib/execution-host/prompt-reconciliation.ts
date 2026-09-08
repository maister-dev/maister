import "server-only";

import type { Logger } from "pino";
import type { Db } from "./db";
import type { CommandReceipt } from "./contracts";
import type { PromptEvidenceResult } from "./prompt-evidence";

import { and, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import pino from "pino";

import {
  depositPromptReceipt,
  quarantinePromptProtocol,
  reconcileStoredPromptEvidence,
} from "./prompt-evidence";
import {
  classifyPromptTransportFailure,
  isPromptProtocolConflict,
} from "./prompt-transport";
import { OPEN_COMMAND_STATES } from "./types";

import { executionCommands } from "@/lib/db/schema";

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
  if (row.receiptEvidence || !input.lookupReceipt)
    return { ...existing, receiptRead: "not_due" };
  const now = input.now ?? (() => new Date());
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
