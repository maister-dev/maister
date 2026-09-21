// ADR-177 — what the current attempt's newest owned `session.prompt` says about
// the turn, as ONE pure function.
//
// PURE on purpose, and for the same reason `attempt-decisions.ts` is: the
// readers sit on both sides of the server boundary. The sweep's builder is
// `server-only` and resolves the row from Postgres; the reconcile classifier
// unit suite has neither a database nor a host. A second copy of the derivation
// order would be a second contract, and the order here is load-bearing twice
// over (see the two comments below), so it exists exactly once.

export const PROMPT_EVIDENCE_CLASSES = [
  // Nothing was dispatched that a host could have lost.
  "none",
  // The host says the turn is still running.
  "inflight",
  // The turn is over on the host; its terminal event has not been ingested.
  "pending_ingest",
  // The command is settled; its owner has not applied it yet.
  "pending_application",
  // A worker holds the application claim right now.
  "applying",
  // The result reached the ledger; the continuation worker owns the next node.
  "applied",
  // The host restarted mid-turn. Not a result — the absence of one.
  "turn_lost",
  // Receipt and terminal event disagreed; owner application stopped.
  "quarantined",
  // Application failed deterministically for some other reason.
  "poisoned",
] as const;

export type PromptEvidenceClass = (typeof PROMPT_EVIDENCE_CLASSES)[number];

/** The row fields the derivation reads, and nothing else. */
export type PromptEvidenceRow = {
  state: string;
  applicationState: string;
  applicationError: Record<string, unknown> | null;
  lastError: Record<string, unknown> | null;
  terminalEventId: string | null;
  terminalEvidenceSha256: string | null;
};

/** What `GET /commands/{id}` said, reduced to the answers that matter.
 *
 * `turn_lost` is the ONLY one that can crash a run, so the probe must PROVE it
 * rather than infer it from a missing signal. `pending_ingest` is the explicit
 * "the receipt exists but proves nothing terminal" answer — a v2 receipt (which
 * carries no liveness field) or a `rejected` receipt for an ordinary failure.
 * `unknown` covers a 404, a network failure and a timeout alike. Both skip. */
export type PromptReceiptProbe =
  | "inflight"
  | "completed"
  | "turn_lost"
  | "pending_ingest"
  // The receipt exists but carries no liveness at all, so this arm has nothing
  // to say in EITHER direction — a v2 receipt in `accepted`. Distinct from
  // `pending_ingest`, which asserts a named writer owes the next move: here
  // nobody is asserted, so the decision falls back to the pre-ADR-177 grace
  // rule rather than to an unconditional skip.
  | "indeterminate"
  | "unknown";

const SETTLED_STATES = new Set(["succeeded", "failed", "fenced"]);
const PRE_DISPATCH_STATES = new Set(["queued", "delivering"]);

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** A host-reported lost turn, matched on the REASON.
 *
 * Never on the error code and never on an HTTP status: the code is
 * `PRECONDITION` when the supervisor's rejected receipt was ingested and
 * `ACP_PROTOCOL` when `foldReceipt`'s accepted-with-no-terminal fallback wrote
 * it. Both shapes are production-reachable and they NEST the reason
 * differently — the ingested terminal event keeps `details.reason`, the
 * fallback flattens it to `reason` — so both are accepted here. Matching only
 * the nested form silently never fires on the fallback path.
 */
export function isTurnLostError(lastError: unknown): boolean {
  if (!record(lastError)) return false;
  if (lastError.reason === "turn_lost") return true;
  const details = lastError.details;

  return record(details) && details.reason === "turn_lost";
}

export function classifyPromptEvidence(
  row: PromptEvidenceRow | null,
  probe?: PromptReceiptProbe,
): PromptEvidenceClass {
  if (!row) return "none";
  if (PRE_DISPATCH_STATES.has(row.state)) return "none";

  // BEFORE the `applied` test, and that ordering is load-bearing: `quarantine()`
  // writes `application_state = completion_applied_at ? "applied" : "poisoned"`,
  // so a conflict found AFTER application reads as `applied` with
  // `application_error` set. Keyed on `poisoned` alone, that row would classify
  // as healthy and a disagreeing turn would be skipped forever.
  if (row.applicationError?.reason === "prompt_terminal_conflict")
    return "quarantined";
  if (row.applicationState === "poisoned") return "poisoned";
  if (
    row.applicationState === "applied" ||
    row.applicationState === "superseded"
  )
    return "applied";
  if (row.applicationState === "applying") return "applying";

  if (SETTLED_STATES.has(row.state)) {
    // BEFORE `pending_application`, and that ordering is load-bearing too: a
    // settled lost turn is the boundary, not something to wait for. Safe only
    // because both writers that can reach it produce ONE row set.
    if (isTurnLostError(row.lastError)) return "turn_lost";

    return "pending_application";
  }

  // `accepted` with no ingested terminal evidence — the one window the ledger
  // cannot answer, and the only one that costs a host call.
  switch (probe) {
    case "inflight":
      return "inflight";
    case "turn_lost":
      return "turn_lost";
    // `none` is deliberate: it is the ONE class that falls through to the grace
    // anchor. A v2 receipt cannot tell a running turn from a lost one, so this
    // arm declines to answer and the rule that governed before ADR-177 decides
    // — which both refuses to crash a turn inside its grace window AND keeps
    // the long-standing safety net for one that is past it.
    case "indeterminate":
      return "none";
    // A receipt that says `completed`, one that proves nothing terminal, and
    // equally one that did not answer: reconcile never invents a terminal
    // outcome from a missing or inconclusive receipt — the command-recovery
    // pass owns that.
    case "completed":
    case "pending_ingest":
    case "unknown":
    default:
      return "pending_ingest";
  }
}
