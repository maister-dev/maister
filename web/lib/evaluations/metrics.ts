// Client-safe (pure): replicate-distribution + timing metric formulas (ADR-142
// metrics contract). Every formula carries a version so a persisted aggregate is
// reproducible. Missing is ALWAYS explicit (null + reason) — never converted to
// numeric zero (D18), and the latest replicate is never the primary ranking.

export const METRICS_FORMULA_VERSION = "1";

// Sorted-array percentile via linear interpolation (P50 = median). Empty input
// returns null (missing, not zero).
export function percentile(values: number[], p: number): number | null {
  const finite = values.filter((v) => Number.isFinite(v));

  if (finite.length === 0) return null;
  if (finite.length === 1) return finite[0];

  const sorted = [...finite].sort((a, b) => a - b);
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);

  if (lo === hi) return sorted[lo];

  const weight = rank - lo;

  return sorted[lo] * (1 - weight) + sorted[hi] * weight;
}

export function mean(values: number[]): number | null {
  const finite = values.filter((v) => Number.isFinite(v));

  if (finite.length === 0) return null;

  return finite.reduce((s, v) => s + v, 0) / finite.length;
}

// Population variance (÷N). Null for an empty set; 0 is a legitimate variance
// for a non-empty constant set (distinct from "missing").
export function variance(values: number[]): number | null {
  const finite = values.filter((v) => Number.isFinite(v));

  if (finite.length === 0) return null;

  const m = finite.reduce((s, v) => s + v, 0) / finite.length;

  return finite.reduce((s, v) => s + (v - m) ** 2, 0) / finite.length;
}

export interface ReplicateInput {
  // The scored value for this replicate (null when the replicate produced no
  // valid result — excluded from distributions but counted).
  value: number | null;
  success: boolean;
}

export interface ReplicateAggregate {
  formulaVersion: string;
  count: number;
  validCount: number;
  successCount: number;
  // Ratio in [0,1]; null when count is 0 (never fabricated).
  successRate: number | null;
  median: number | null;
  p90: number | null;
  variance: number | null;
  mean: number | null;
}

// Distribution over a replicate group. `count` is every replicate; `validCount`
// only those with a numeric value. Distribution stats use valid values only.
export function computeReplicateAggregate(
  replicates: ReplicateInput[],
): ReplicateAggregate {
  const count = replicates.length;
  const values = replicates
    .map((r) => r.value)
    .filter((v): v is number => v !== null && Number.isFinite(v));
  const successCount = replicates.filter((r) => r.success).length;

  return {
    formulaVersion: METRICS_FORMULA_VERSION,
    count,
    validCount: values.length,
    successCount,
    successRate: count === 0 ? null : successCount / count,
    median: percentile(values, 50),
    p90: percentile(values, 90),
    variance: variance(values),
    mean: mean(values),
  };
}

// Cost-to-success: total (priced) cost divided by successful replicates.
// Returns unavailable (never 0) when cost is unpriced (D18) or there are no
// successes.
export function costToSuccess(args: {
  totalCostUsd: number | null;
  successCount: number;
}): { value: number | null; unit: "usd_per_success"; reason?: string } {
  if (args.totalCostUsd === null) {
    return {
      value: null,
      unit: "usd_per_success",
      reason: "monetary cost unavailable (no versioned pricing catalog)",
    };
  }
  if (args.successCount === 0) {
    return {
      value: null,
      unit: "usd_per_success",
      reason: "no successful replicate to divide cost by",
    };
  }

  return {
    value: args.totalCostUsd / args.successCount,
    unit: "usd_per_success",
  };
}

// Process timing intervals for one participant Run (ADR-142 metrics). Each is
// derived from recorded timestamps; a missing input yields null (explicit),
// never a fabricated 0-duration.
export interface RunTimings {
  enqueuedAt?: number | null;
  startedAt?: number | null;
  finishedAt?: number | null;
  // Summed intervals the Run spent waiting on human input / attention.
  hitlWaitMs?: number | null;
}

export interface TimingIntervals {
  formulaVersion: string;
  wallMs: number | null;
  queuedMs: number | null;
  activeMs: number | null;
  hitlWaitMs: number | null;
}

function diff(a?: number | null, b?: number | null): number | null {
  if (a == null || b == null) return null;

  const d = b - a;

  return d >= 0 ? d : null;
}

export function computeTimingIntervals(t: RunTimings): TimingIntervals {
  const wallMs = diff(t.startedAt, t.finishedAt);
  const queuedMs = diff(t.enqueuedAt, t.startedAt);
  const hitlWaitMs =
    t.hitlWaitMs != null && t.hitlWaitMs >= 0 ? t.hitlWaitMs : null;
  // Active = wall minus HITL wait (queue wait is a separate interval, metered
  // before the session reaches Running — D12).
  const activeMs =
    wallMs != null && hitlWaitMs != null
      ? Math.max(0, wallMs - hitlWaitMs)
      : wallMs;

  return {
    formulaVersion: METRICS_FORMULA_VERSION,
    wallMs,
    queuedMs,
    activeMs,
    hitlWaitMs,
  };
}
