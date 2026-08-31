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
