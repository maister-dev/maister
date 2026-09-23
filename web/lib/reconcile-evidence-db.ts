import "server-only";

import type { ExecutionHostTransport } from "./execution-host/contracts";
import type {
  PromptEvidenceClass,
  PromptReceiptProbe,
} from "./reconcile-evidence";

import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import pino from "pino";

import * as schemaModule from "@/lib/db/schema";
import { commandStreamLost } from "@/lib/execution-host/events/stream-health";
import {
  classifyPromptEvidence,
  isTurnLostError,
} from "@/lib/reconcile-evidence";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { executionCommands, nodeAttempts } = schemaModule as unknown as Record<
  string,
  any
>;

// FIXME(any): dual drizzle-orm peer-dep variants.
type Db = any;

const log = pino({
  name: "reconcile-evidence",
  level: process.env.LOG_LEVEL ?? "info",
});

/** The attempt an evidence decision and its follow-up write must BOTH be about.
 *
 * ONE predicate, exported, because the sweep classifies from it and
 * `applyTurnLostBoundary` acts on it. They used to resolve it differently — the
 * probe took the run's newest `node_attempts` row (any node, any status) while
 * the boundary took the open `Running` attempt at `current_step_id` — so a run
 * whose newest attempt was closed, or was at another node, could be CLASSIFIED
 * from attempt A and ACTED on at attempt B. The boundary re-resolves its own
 * command, so evidence was never cross-applied; the failure mode was the
 * boundary answering `not-claimed`, the sweep logging a lost CAS, and the run
 * staying `Running` with nothing bounding the next tick.
 *
 * Deliberately NOT the grace anchor. That stays run-scoped (`latestAttemptRow`
 * in `reconcile.ts`) because "how long since this run last did anything" is a
 * different question from "which attempt owns the turn in flight".
 */
export async function resolveEvidenceAttemptId(
  db: Db,
  input: { runId: string; nodeId: string },
): Promise<string | null> {
  const [attempt] = await db
    .select({ id: nodeAttempts.id })
    .from(nodeAttempts)
    .where(
      and(
        eq(nodeAttempts.runId, input.runId),
        eq(nodeAttempts.nodeId, input.nodeId),
        eq(nodeAttempts.status, "Running"),
        isNull(nodeAttempts.endedAt),
      ),
    )
    .orderBy(desc(nodeAttempts.startedAt))
    .limit(1);

  return attempt?.id ?? null;
}

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

/** A lost turn must be AFFIRMATIVELY proven by the receipt, never inferred from
 * the absence of a signal. Two ways the earlier "anything not completed and not
 * inflight is lost" reading was wrong, both reachable in production:
 *
 * 1. **v2 receipts carry no liveness.** `normalizeCommandReceiptV2` hardcodes
 *    `inflight: false` because the v2 wire shape has no such field, and v2's
 *    phase enum includes `accepted`. An accepted v2 receipt for a turn that is
 *    still running therefore looked exactly like a lost one — and the sweep
 *    snapshots live sessions BEFORE loading candidates, so a session that
 *    started after the snapshot has no liveness cover either. That crashed a
 *    healthy turn and threw away the result it was about to produce.
 * 2. **`rejected` is the ordinary failure phase too.** The supervisor's
 *    `completeAsync` catch writes `rejected` for any turn that errored. Mapping
 *    every `rejected` to `turn_lost` turned an ordinary failed turn — which the
 *    owner should apply as a failed node action — into a run crash.
 *
 * Nothing this function cannot prove ever returns `turn_lost`. It answers
 * `pending_ingest` — which SKIPS, leaving the command to the recovery pass and
 * the owner worker that own it — except for the one shape that asserts no
 * writer at all, a v2 `accepted` receipt, which answers `indeterminate` and
 * defers to the grace rule rather than skipping forever.
 */
export async function probeReceipt(
  transport: ExecutionHostTransport,
  commandId: string,
): Promise<PromptReceiptProbe> {
  try {
    const receipt = await transport.getCommandReceipt(commandId);

    // A 404 is `receipt_missing` on the recovery path, which that pass already
    // terminalizes. Reconcile hands it back as `unknown` rather than inventing
    // a terminal outcome from an absent receipt.
    if (!receipt) return "unknown";
    if (receipt.phase === "completed") return "completed";
    if (receipt.phase === "accepted") {
      // Only the v1 shape carries liveness. `accepted` + `inflight:false` on v1
      // IS the turn_lost signature; on v2 the same fields mean nothing, because
      // `receiptToResponse` takes an `inflight` argument and DROPS it for
      // `requestVersion === 2` — the v2 wire shape has no such field, and
      // `normalizeCommandReceiptV2` then hardcodes `false`.
      //
      // So a v2 accepted receipt is `indeterminate`, not `pending_ingest`: an
      // unconditional skip would strip the pre-ADR-177 safety net from the
      // production path (v2 IS the production request schema) and leave a run
      // whose terminal event never arrives waiting forever. Deferring to the
      // grace rule refuses to crash a turn inside its window — which is the
      // actual harm here, since the sweep snapshots sessions BEFORE loading
      // candidates and a just-started turn can look session-less — while still
      // crashing one that is long past it.
      if (receipt.evidenceV2) return "indeterminate";

      return receipt.inflight ? "inflight" : "turn_lost";
    }

    // `rejected`: the host refused or the turn errored. Only the turn_lost
    // REASON distinguishes the two, and an ordinary failure belongs to the
    // owner, not to a crash.
    return isTurnLostError(receipt.body) ? "turn_lost" : "pending_ingest";
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
  /** The attempt this classification is ABOUT. Carried to the writer so it
   * acts on the row that was classified rather than on whatever the same
   * lookup returns a moment later. */
  nodeAttemptId: string | null;
};

export const NO_PROMPT_EVIDENCE: ResolvedPromptEvidence = {
  evidence: "none",
  streamLost: false,
  commandId: null,
  nodeAttemptId: null,
};

/** A poisoned consensus generation is a terminal owner refusal even if its
 * supervisor session remains live. It belongs to the current open attempt;
 * old or closed-attempt generations cannot crash a new attempt. */
export async function resolveConsensusPoisonEvidence(
  db: Db,
  input: { runId: string; nodeId: string },
): Promise<ResolvedPromptEvidence> {
  const nodeAttemptId = await resolveEvidenceAttemptId(db, input);

  if (!nodeAttemptId) return NO_PROMPT_EVIDENCE;
  const [row] = await db
    .select({
      id: executionCommands.id,
      applicationState: executionCommands.applicationState,
    })
    .from(executionCommands)
    .where(
      and(
        eq(executionCommands.runId, input.runId),
        eq(executionCommands.kind, "session.prompt"),
        sql`${executionCommands.ownerRef}->>'variant' IN ('consensus_verifier', 'consensus_synthesis')`,
        sql`${executionCommands.ownerRef}->>'nodeAttemptId' = ${nodeAttemptId}`,
        inArray(executionCommands.applicationState, [
          "poisoned",
          "quarantined",
        ]),
      ),
    )
    .orderBy(desc(executionCommands.createdAt))
    .limit(1);

  if (!row) return NO_PROMPT_EVIDENCE;

  return {
    evidence: row.applicationState,
    streamLost: false,
    commandId: row.id,
    nodeAttemptId,
  };
}

/** Resolve one candidate's prompt evidence for the reconcile classifier.
 *
 * Called from the sweep's per-candidate enrichment block, so it inherits that
 * loop's bounded concurrency and needs no bound of its own.
 */
export async function resolvePromptEvidence(
  db: Db,
  transport: ExecutionHostTransport,
  input: { runId: string; nodeId: string },
): Promise<ResolvedPromptEvidence> {
  const nodeAttemptId = await resolveEvidenceAttemptId(db, input);

  if (!nodeAttemptId) return NO_PROMPT_EVIDENCE;
  const row = await loadPromptEvidence(db, {
    runId: input.runId,
    nodeAttemptId,
  });

  if (!row) return NO_PROMPT_EVIDENCE;
  const probed = needsReceiptProbe(row);
  const probe = probed ? await probeReceipt(transport, row.id) : undefined;
  const evidence = classifyPromptEvidence(row, probe);

  if (evidence === "none")
    return { evidence, streamLost: false, commandId: row.id, nodeAttemptId };

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

  return { evidence, streamLost, commandId: row.id, nodeAttemptId };
}
