import "server-only";

import type { ExecutionHostTransport } from "./execution-host/contracts";
import type {
  PromptEvidenceClass,
  PromptReceiptProbe,
} from "./reconcile-evidence";

import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import pino from "pino";

import * as schemaModule from "@/lib/db/schema";
import { getCommand } from "@/lib/execution-host/commands";
import { commandStreamLost } from "@/lib/execution-host/events/stream-health";
import {
  hostSpanEligible,
  reconcilePromptCommand,
} from "@/lib/execution-host/prompt-reconciliation";
import {
  classifyPromptEvidence,
  isTurnLostError,
} from "@/lib/reconcile-evidence";
import { isMaisterError } from "@/lib/errors";

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

/** ADR-177 (amended 2026-09-23): the owned prompts that ARE the current
 * attempt's turn on an agent node. The action (`node`); the same action
 * continued after a permission answer (`permission_resume` — same attempt, same
 * prompt ordinal, a NEWER command); and the gate evaluations that run on the
 * attempt after its action applied (`gate_ai`, `gate_skill`). Reading `node`
 * alone answered `applied` from the finished turn before them. The consensus
 * variants are not the attempt's turn here: a consensus node is outside the
 * sweep's evidence gate. */
export const CURRENT_TURN_VARIANTS = [
  "node",
  "permission_resume",
  "gate_ai",
  "gate_skill",
] as const;

/** The current attempt's newest OWNED `session.prompt` among `variants`.
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
  input: {
    runId: string;
    nodeAttemptId: string;
    // Required, never defaulted: crash classification passes
    // CURRENT_TURN_VARIANTS, the duration watchdog (ADR-167 D5 amendment,
    // D-C1) every flow_node_attempt variant.
    variants: readonly string[];
  },
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
        inArray(sql`${executionCommands.ownerRef}->>'variant'`, [
          ...input.variants,
        ]),
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
export function needsReceiptProbe(row: PromptEvidenceLookup): boolean {
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
  /** The bound on the skip arms: the holding host's stream is `lost` AND no
   * host-evidence read of this command is still owed an answer. False while
   * such a read is in flight, the host last answered busy, or the receipt is
   * still being read (D-B7), because the evidence can then still arrive. */
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

/** A poisoned or quarantined consensus generation is a terminal owner refusal
 * even if its supervisor session remains live. It belongs to the current open
 * attempt; old or closed-attempt generations cannot crash a new attempt. The
 * row is classified by `classifyPromptEvidence`, whose quarantine test reads
 * `application_error` because a conflict found after application stays
 * `applied`. */
export async function resolveConsensusPoisonEvidence(
  db: Db,
  input: { runId: string; nodeId: string },
): Promise<ResolvedPromptEvidence> {
  const nodeAttemptId = await resolveEvidenceAttemptId(db, input);

  if (!nodeAttemptId) return NO_PROMPT_EVIDENCE;
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
        sql`${executionCommands.ownerRef}->>'variant' IN ('consensus_verifier', 'consensus_synthesis')`,
        sql`${executionCommands.ownerRef}->>'nodeAttemptId' = ${nodeAttemptId}`,
        or(
          eq(executionCommands.applicationState, "poisoned"),
          sql`${executionCommands.applicationError}->>'reason' = 'prompt_terminal_conflict'`,
        ),
      ),
    )
    .orderBy(desc(executionCommands.createdAt))
    .limit(1);
  const evidence = classifyPromptEvidence(row ?? null);

  if (evidence !== "poisoned" && evidence !== "quarantined")
    return NO_PROMPT_EVIDENCE;

  return {
    evidence,
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
    variants: CURRENT_TURN_VARIANTS,
  });

  if (!row) return NO_PROMPT_EVIDENCE;
  const probed = needsReceiptProbe(row);
  const probe = probed ? await probeReceipt(transport, row.id) : undefined;
  let evidence = classifyPromptEvidence(row, probe);

  if (evidence === "none")
    return { evidence, streamLost: false, commandId: row.id, nodeAttemptId };

  // The ONLY bound on the skip arms: the state `runEventStreamHealthSweep`
  // writes when this manager gives up on a host's stream. Never a timer.
  const streamLost = await commandStreamLost({ db, commandId: row.id });

  // ADR-167 D5 amendment (D-B7): a turn the host completed is not lost with
  // the stream. Before the stream-lost arm crashes it, offer it once to the
  // host-evidence feeds (the direct binding, then the verified host span) and
  // classify again. With a live stream `pending_ingest` keeps its meaning —
  // the waiting writer owes the next move — so nothing is read here.
  let hostReadPending = false;

  if (streamLost && evidence === "pending_ingest" && probe === "completed") {
    // Never throws, like `probeReceipt`: a host that could not answer is no
    // evidence, and one candidate's throw would reject the whole sweep pass
    // (`runWithConcurrency` is a Promise.all). A failed offer settles nothing;
    // the verdict rule below decides from the row as it stands.
    const offered = await reconcilePromptCommand({
      db,
      commandId: row.id,
      lookupReceipt: (id) => transport.getCommandReceipt(id),
    }).catch((error: unknown) => {
      log.warn(
        {
          runId: input.runId,
          commandId: row.id,
          causeCode: isMaisterError(error)
            ? error.code
            : error instanceof Error
              ? error.name
              : "unknown",
        },
        "reconcile-evidence-host-offer-failed",
      );

      return null;
    });
    const settled = await loadPromptEvidence(db, {
      runId: input.runId,
      nodeAttemptId,
      variants: CURRENT_TURN_VARIANTS,
    });

    if (settled?.terminalEvidenceSha256) {
      evidence = classifyPromptEvidence(settled);
      log.info(
        { runId: input.runId, commandId: row.id, evidence },
        "reconcile-evidence-settled-from-host",
      );
    } else {
      // Only a read that ANSWERED is a verdict. A missing receipt means
      // another reader holds the receipt claim; an eligible command with no
      // verdict has a read in flight (a claim clears it) — that reader may be
      // settling a readable result right now; `busy` asked for a retry. Every
      // read ends in a verdict or a settlement and the sweep reads itself
      // whenever the claim is free, so this waits on the next answer, never
      // on a timer. A recorded refusal, or a command the host span cannot
      // settle at all, leaves nothing to wait for.
      const current = offered?.command ?? (await getCommand(db, row.id));

      hostReadPending =
        !!current &&
        (!current.receiptEvidence ||
          (hostSpanEligible(current) && current.hostSpanVerdict !== "refused"));
      if (hostReadPending)
        log.info(
          {
            runId: input.runId,
            commandId: row.id,
            hostSpanVerdict: current?.hostSpanVerdict ?? null,
          },
          "reconcile-evidence-host-read-pending",
        );
    }
  }

  if (probed) {
    log.info(
      {
        runId: input.runId,
        commandId: row.id,
        evidence,
        streamLost,
        hostReadPending,
        probe,
      },
      "reconcile: prompt evidence probed",
    );
  }

  return {
    evidence,
    streamLost: streamLost && !hostReadPending,
    commandId: row.id,
    nodeAttemptId,
  };
}
