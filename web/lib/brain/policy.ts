import "server-only";

// Shared retrieval and lifetime policy. Similarity identifies review candidates;
// scores, recurrence and applicability never establish factual confirmation.
export const BRAIN_POLICY = {
  // Similarity threshold for a potential claim-conflict review candidate.
  dedupCosineThreshold: 0.85,
  // Initial retrieval confidence; independent of basis and confirmation.
  initialConfidence: 0.3,
  // lesson/observation TTL (days) — expires_at = now + this on insert.
  ttlDays: 30,
  // ambient recall top-K injected into the P7 run-context.
  ambientK: 5,
  // Sub-project B: indexed chunks fill only leftover ambient slots.
  ambientIndexedMax: 2,
  ambientIndexedMinScore: 0.25,
  // Ambient retrieval floor. It never indicates factual confirmation. It must not
  // exceed initialConfidence: retain no longer reinforces, so nothing raises an
  // item's confidence and a higher floor would exclude every new item.
  // Explicit recall (ext route / MCP) is NOT floored; callers pass their own.
  ambientMinConfidence: 0.3,
  // brain_snapshots older than this are pruned by the decay sweep (audit
  // evidence, not source of truth — unbounded growth otherwise: ambient writes
  // one row per run × generation).
  snapshotTtlDays: 30,
} as const;

export type BrainPolicy = typeof BRAIN_POLICY;
