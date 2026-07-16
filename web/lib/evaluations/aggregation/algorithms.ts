// Client-safe (pure): the M46 aggregation registry — weighted_mean@1, median@1,
// majority@1 (ADR-145 D13). Deterministic, unrounded internally with explicit
// display rounding, missing NEVER becomes zero, and every number traces to the
// exact included attempts. One method = one aggregation; incompatible methods are
// never collapsed into a universal score.

import type { AggregationAlgorithm } from "@/lib/evaluations/method-schema";
import type { EvaluationCriterionState } from "@/lib/evaluations/types";

export const AGGREGATION_DISPLAY_DECIMALS = 2;

export interface AggCriterion {
  id: string;
  weight: number;
  normalizedWeight: number;
  scaleMin: number;
  scaleMax: number;
  itemCap?: number;
  optional: boolean;
}

export interface AttemptCriterionScore {
  state: EvaluationCriterionState;
  score: number | null;
}

export interface AttemptResult {
  attemptId: string;
  valid: boolean;
  // criterionId -> score/state. A criterion absent here is treated as
  // insufficient_evidence (never a 0).
  criteria: Record<string, AttemptCriterionScore>;
}

export interface CriterionAggregate {
  criterionId: string;
  state: EvaluationCriterionState;
  // Unrounded aggregate over the SCORED attempts for this criterion; null when no
  // attempt scored it (insufficient_evidence — never 0).
  rawValue: number | null;
  displayValue: number | null;
  includedAttemptIds: string[];
  // max - min of the scored values (0 for a single value; null when none).
  spread: number | null;
  capped: boolean;
}

export interface AggregateResult {
  algorithm: AggregationAlgorithm;
  quorum: number;
  quorumMet: boolean;
  includedAttemptIds: string[];
  excludedAttempts: Array<{ attemptId: string; reason: string }>;
  perCriterion: CriterionAggregate[];
  // Weight-renormalized over the criteria that HAVE a value (missing excluded,
  // never zero-filled). Null when no criterion had any scored attempt.
  rawTotal: number | null;
  displayTotal: number | null;
  totalCapped: boolean;
}

function roundDisplay(value: number): number {
  const f = 10 ** AGGREGATION_DISPLAY_DECIMALS;

  return Math.round(value * f) / f;
}

function clampCap(
  value: number,
  cap: number | undefined,
): {
  value: number;
  capped: boolean;
} {
  if (cap !== undefined && value > cap) return { value: cap, capped: true };

  return { value, capped: false };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);

  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

// Majority = the most frequent scored value; ties resolve to the LOWEST value
// (conservative, deterministic — no hidden tie ambiguity, D13).
function majority(values: number[]): number {
  const counts = new Map<number, number>();

  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);

  let best = values[0];
  let bestCount = -1;

  for (const [value, count] of counts) {
    if (count > bestCount || (count === bestCount && value < best)) {
      best = value;
      bestCount = count;
    }
  }

  return best;
}

function combine(values: number[], algorithm: AggregationAlgorithm): number {
  switch (algorithm) {
    case "weighted_mean@1":
      return values.reduce((s, v) => s + v, 0) / values.length;
    case "median@1":
      return median(values);
    case "majority@1":
      return majority(values);
    case "pairwise_tournament@1":
      // Non-scalar: pairwise methods aggregate through computeTournament, never
      // this per-criterion combine (defensive — routing keeps them apart).
      throw new Error(
        "pairwise_tournament@1 is not a scalar aggregation; use computeTournament",
      );
  }
}

// Aggregate one Evaluation Execution's judge attempts into a deterministic,
// auditable result. Only VALID attempts count; quorum is checked against the
// valid count. A criterion with no scored value is insufficient_evidence and is
// EXCLUDED from the total with weight renormalization (never numeric zero).
export function computeAggregate(input: {
  algorithm: AggregationAlgorithm;
  quorum: number;
  criteria: AggCriterion[];
  attempts: AttemptResult[];
  totalMax?: number;
}): AggregateResult {
  const excludedAttempts: Array<{ attemptId: string; reason: string }> = [];
  const validAttempts = input.attempts.filter((a) => {
    if (!a.valid) {
      excludedAttempts.push({ attemptId: a.attemptId, reason: "invalid" });

      return false;
    }

    return true;
  });

  const includedAttemptIds = validAttempts.map((a) => a.attemptId);
  const quorumMet = validAttempts.length >= input.quorum;

  const perCriterion: CriterionAggregate[] = input.criteria.map((c) => {
    const scored: Array<{ attemptId: string; score: number }> = [];

    for (const attempt of validAttempts) {
      const cell = attempt.criteria[c.id];

      if (cell && cell.state === "scored" && cell.score !== null) {
        scored.push({ attemptId: attempt.attemptId, score: cell.score });
      }
    }

    if (scored.length === 0) {
      return {
        criterionId: c.id,
        state: "insufficient_evidence",
        rawValue: null,
        displayValue: null,
        includedAttemptIds: [],
        spread: null,
        capped: false,
      };
    }

    const values = scored.map((s) => s.score);
    const combined = combine(values, input.algorithm);
    const { value: capped, capped: wasCapped } = clampCap(combined, c.itemCap);

    return {
      criterionId: c.id,
      state: "scored",
      rawValue: capped,
      displayValue: roundDisplay(capped),
      includedAttemptIds: scored.map((s) => s.attemptId),
      spread: Math.max(...values) - Math.min(...values),
      capped: wasCapped,
    };
  });

  // Weighted total renormalized over criteria that HAVE a value (missing
  // excluded, never zero). Unrounded internally; rounded only for display.
  const present = perCriterion.filter(
    (p) => p.state === "scored" && p.rawValue !== null,
  );
  const weightByCriterion = new Map(
    input.criteria.map((c) => [c.id, c.weight]),
  );
  const presentWeight = present.reduce(
    (s, p) => s + (weightByCriterion.get(p.criterionId) ?? 0),
    0,
  );

  let rawTotal: number | null = null;
  let totalCapped = false;

  if (present.length > 0 && presentWeight > 0) {
    const weighted = present.reduce(
      (s, p) =>
        s +
        (weightByCriterion.get(p.criterionId) ?? 0) * (p.rawValue as number),
      0,
    );
    const normalized = weighted / presentWeight;
    const { value, capped } = clampCap(normalized, input.totalMax);

    rawTotal = value;
    totalCapped = capped;
  }

  return {
    algorithm: input.algorithm,
    quorum: input.quorum,
    quorumMet,
    includedAttemptIds,
    excludedAttempts,
    perCriterion,
    rawTotal,
    displayTotal: rawTotal === null ? null : roundDisplay(rawTotal),
    totalCapped,
  };
}
