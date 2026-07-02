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
  // Ambient injection floor: confidence₀ (0.3) + one reinforce step — an item
  // must have recurred at least once before it is auto-injected into runs.
  // Explicit recall (ext route / MCP) is NOT floored; callers pass their own.
  ambientMinConfidence: 0.4,
  // brain_snapshots older than this are pruned by the decay sweep (audit
  // evidence, not source of truth — unbounded growth otherwise: ambient writes
  // one row per run × generation).
  snapshotTtlDays: 30,
} as const;

export type BrainPolicy = typeof BRAIN_POLICY;
