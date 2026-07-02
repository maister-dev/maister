import "server-only";

// Project Brain (ADR-122, scope decision 7 / spec §11) policy constants.
// Owner-approved defaults, marked tune-on-real-runs. NOT env, NOT DB in
// Sub-project A — a deliberate choice so behavior is deterministic until real
// runs justify a knob. One dedup rule (τ + reinforce) gives dedup +
// recurrence-promotion + the decay valve.
export const BRAIN_POLICY = {
  // τ: reinforce (not duplicate) an active item whose cosine similarity to the
  // new content is strictly greater than this.
  dedupCosineThreshold: 0.85,
  // confidence₀: inserted below any auto-apply threshold; recurrence promotes it.
  initialConfidence: 0.3,
  // lesson/observation TTL (days) — expires_at = now + this on insert.
  ttlDays: 30,
  // reinforce: bump confidence by this (clamped ≤ 1) ...
  reinforceConfidenceStep: 0.1,
  // ... and push expires_at out by this many days.
  reinforceTtlDays: 30,
  // ambient recall top-K injected into the P7 run-context.
  ambientK: 5,
} as const;

export type BrainPolicy = typeof BRAIN_POLICY;
