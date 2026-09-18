// The `node_attempts.decision` values that carry PROVENANCE — who closed the
// attempt and why — as opposed to a flow-declared transition name.
//
// Pure on purpose: no `server-only`, no db, no logging deps. The readers are
// split across the server boundary (the ledger writer and the HITL service are
// server-only; Observatory rollups and the rework-budget math are pure and
// unit-tested without Postgres), so a single importable definition is the only
// way both halves agree. Keeping a literal copy on the pure side is what these
// constants replace.
export const REVIEW_REWORK_CLAIM_DECISION = "review_rework_claim";

export const OPERATOR_INTERRUPT_DECISION = "operator_interrupt";

// ADR-175: marks the attempt an operator Recover closed so a crashed agent node
// could be re-dispatched as a fresh attempt under the epoch the recover claim
// minted. Excluded from `rework.maxLoops` and from BOTH Observatory correction
// counters, for the same reason operator restarts are — the attempt counter
// advanced without a failed automated iteration. Deliberately NOT part of the
// `MAISTER_MAX_OPERATOR_RESTARTS` budget: a crash is not an operator action, and
// charging it there would let crashes consume a reviewer's restart allowance.
export const CRASH_RECOVER_DECISION = "crash_recover";

// The decisions that close an attempt WITHOUT it counting as a correction: the
// attempt number advanced, but no automated iteration failed. Both counters and
// the rework budget subtract this whole set, never one member of it.
export const NON_CORRECTION_DECISIONS: readonly string[] = [
  OPERATOR_INTERRUPT_DECISION,
  CRASH_RECOVER_DECISION,
];
