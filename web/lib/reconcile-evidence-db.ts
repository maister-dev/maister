import "server-only";

import type { ExecutionHostTransport } from "./execution-host/contracts";
import type { PromptEvidenceClass, PromptReceiptProbe } from "./reconcile-evidence";

import { and, desc, eq, sql } from "drizzle-orm";
import pino from "pino";

import * as schemaModule from "@/lib/db/schema";
import { commandStreamLost } from "@/lib/execution-host/events/stream-health";
import { classifyPromptEvidence } from "@/lib/reconcile-evidence";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { executionCommands } = schemaModule as unknown as Record<string, any>;

// FIXME(any): dual drizzle-orm peer-dep variants.
type Db = any;

const log = pino({
  name: "reconcile-evidence",
  level: process.env.LOG_LEVEL ?? "info",
});

export type PromptEvidenceLookup = {
  id: string;
  state: string;
  applicationState: string;
  applicationError: Record<string, unknown> | null;
  lastError: Record<string, unknown> | null;
  terminalEventId: string | null;
  terminalEvidenceSha256: string | null;
};

/** The current attempt's newest OWNED `session.prompt`.
 *
 * Attempt-scoped by `owner_ref->>'nodeAttemptId'`, which is what makes a
 * command orphaned on a CLOSED attempt invisible here — and therefore what
 * makes ADR-177's Recover arm responsible for discharging one, since nothing
 * else ever will.
 *
 * Reuses the ADR-175 lookup shape verbatim (`crash-recover.ts`) rather than
 * inventing a second one: owner-filtered in SQL and capped at one row, because
 * selecting a run's whole prompt history pulls each turn's
 * `request_canonical_json` back to satisfy one match. There is no index on
 * `owner_ref`, but `execution_commands_run_created_idx` on `(run_id,
 * created_at)` serves this as a short index scan — the equality predicate leads
 * and the sort follows it.
 */
export async function loadPromptEvidence(
  db: Db,
  input: { runId: string; nodeAttemptId: string },
): Promise<PromptEvidenceLookup | null> {
  const [row] = await db
    .select({
      id: executionCommands.id,
      state: executionCommands.state,
      applicationState: executionCommands.applicationState,
      applicationError: executionCommands.applicationError,
      lastError: executionCommands.lastError,
      terminalEventId: executionCommands.terminalEventId,
      terminalEvidenceSha256: executionCommands.terminalEvidenceSha256,
    })
    .from(executionCommands)
    .where(
      and(
        eq(executionCommands.runId, input.runId),
        eq(executionCommands.kind, "session.prompt"),
        sql`${executionCommands.ownerRef}->>'variant' = 'node'`,
        sql`${executionCommands.ownerRef}->>'nodeAttemptId' = ${input.nodeAttemptId}`,
      ),
    )
    .orderBy(desc(executionCommands.createdAt))
    .limit(1);

  return row ?? null;
}

/** Does this row still need a host call to be classified? Only an `accepted`
 * row with no ingested terminal evidence does — every other shape is answered
 * by the ledger alone, which is what keeps the probe per-rare-candidate. */
function needsReceiptProbe(row: PromptEvidenceLookup): boolean {
  return (
    row.state === "accepted" &&
    !row.terminalEvidenceSha256 &&
    !row.terminalEventId
  );
}

async function probeReceipt(
  transport: ExecutionHostTransport,
  commandId: string,
): Promise<PromptReceiptProbe> {
  try {
    const receipt = await transport.getCommandReceipt(commandId);

    // A 404 is `receipt_missing` on the recovery path, which that pass already
    // terminalizes. Reconcile hands it back as `unknown` rather than inventing
    // a terminal outcome from an absent receipt.
    if (!receipt) return "unknown";
    if (receipt.inflight) return "inflight";
    if (receipt.phase === "completed") return "completed";

    // `accepted` + `inflight:false` IS the turn_lost signature; a `rejected`
    // receipt carries the reason in its body.
    return "turn_lost";
  } catch {
    // A probe that could not answer is not evidence. `unknown` yields
    // `pending_ingest`, which SKIPS — a transport blip must never crash a run.
    return "unknown";
  }
}

export type ResolvedPromptEvidence = {
  evidence: PromptEvidenceClass;
  streamLost: boolean;
  commandId: string | null;
  probed: boolean;
};

export const NO_PROMPT_EVIDENCE: ResolvedPromptEvidence = {
  evidence: "none",
  streamLost: false,
  commandId: null,
  probed: false,
};

/** Resolve one candidate's prompt evidence for the reconcile classifier.
 *
 * Called from the sweep's per-candidate enrichment block, so it inherits that
 * loop's bounded concurrency and needs no bound of its own.
 */
export async function resolvePromptEvidence(
  db: Db,
  transport: ExecutionHostTransport,
  input: { runId: string; nodeAttemptId: string | null },
): Promise<ResolvedPromptEvidence> {
  if (!input.nodeAttemptId) return NO_PROMPT_EVIDENCE;
  const row = await loadPromptEvidence(db, {
    runId: input.runId,
    nodeAttemptId: input.nodeAttemptId,
  });

  if (!row) return NO_PROMPT_EVIDENCE;
  const probed = needsReceiptProbe(row);
  const probe = probed ? await probeReceipt(transport, row.id) : undefined;
  const evidence = classifyPromptEvidence(row, probe);

  if (evidence === "none")
    return { evidence, streamLost: false, commandId: row.id, probed };

  // The ONLY bound on the skip arms: the state `runEventStreamHealthSweep`
  // writes when this manager gives up on a host's stream. Never a timer.
  const streamLost = await commandStreamLost({ db, commandId: row.id });

  if (probed) {
    log.info(
      {
        runId: input.runId,
        commandId: row.id,
        evidence,
        streamLost,
        probe,
      },
      "reconcile: prompt evidence probed",
    );
  }

  return { evidence, streamLost, commandId: row.id, probed };
}
