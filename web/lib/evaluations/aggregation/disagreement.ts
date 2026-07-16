// Client-safe (pure): disagreement classification (ADR-142 D13). Considers score
// spread, confidence spread, insufficient-evidence asymmetry, objective
// contradiction, and panel completeness. Low disagreement is NOT relabeled as
// high confidence — incomplete evidence keeps its own signal. Thresholds use
// explicit inclusive comparators so there is no hidden `>` vs `>=` ambiguity.

import type { CriterionAggregate } from "./algorithms";

export const DISAGREEMENT_HIGH_SPREAD_INCLUSIVE = 2; // scale points, >= is high
export const DISAGREEMENT_HIGH_CONFIDENCE_SPREAD_INCLUSIVE = 0.5; // [0,1], >= high

export type DisagreementLevel = "none" | "low" | "high";

export interface DisagreementSignals {
  maxScoreSpread: number | null;
  confidenceSpread: number | null;
  // Some valid attempts scored a criterion while others marked it insufficient.
  insufficientAsymmetry: boolean;
  // An objective gate failed but the panel still scored the criterion highly.
  objectiveContradiction: boolean;
  // Fewer valid attempts than the panel expected (incomplete coverage).
  panelIncomplete: boolean;
}

export interface DisagreementResult {
  level: DisagreementLevel;
  reviewRequired: boolean;
  signals: DisagreementSignals;
}

export function classifyDisagreement(input: {
  perCriterion: CriterionAggregate[];
  // One confidence per valid attempt in [0,1] (empty when not reported).
  attemptConfidences: number[];
  validAttemptCount: number;
  expectedAttemptCount: number;
  objectiveGatingFailed: boolean;
  // Highest per-criterion display value the panel produced (for contradiction).
  topCriterionValue: number | null;
  criterionScaleMax: number;
}): DisagreementResult {
  const spreads = input.perCriterion
    .map((c) => c.spread)
    .filter((s): s is number => s !== null);
  const maxScoreSpread = spreads.length ? Math.max(...spreads) : null;

  const confidenceSpread =
    input.attemptConfidences.length >= 2
      ? Math.max(...input.attemptConfidences) -
        Math.min(...input.attemptConfidences)
      : null;

  const insufficientAsymmetry = input.perCriterion.some(
    (c) =>
      c.state === "scored" &&
      c.includedAttemptIds.length > 0 &&
      c.includedAttemptIds.length < input.validAttemptCount,
  );

  // A high panel score while an objective gate failed is a contradiction the
  // reviewer must resolve — the panel cannot override a recorded failure.
  const objectiveContradiction =
    input.objectiveGatingFailed &&
    input.topCriterionValue !== null &&
    input.topCriterionValue >= input.criterionScaleMax * 0.6;

  const panelIncomplete = input.validAttemptCount < input.expectedAttemptCount;

  const signals: DisagreementSignals = {
    maxScoreSpread,
    confidenceSpread,
    insufficientAsymmetry,
    objectiveContradiction,
    panelIncomplete,
  };

  const highBySpread =
    maxScoreSpread !== null &&
    maxScoreSpread >= DISAGREEMENT_HIGH_SPREAD_INCLUSIVE;
  const highByConfidence =
    confidenceSpread !== null &&
    confidenceSpread >= DISAGREEMENT_HIGH_CONFIDENCE_SPREAD_INCLUSIVE;

  const high =
    highBySpread ||
    highByConfidence ||
    objectiveContradiction ||
    insufficientAsymmetry;

  const level: DisagreementLevel = high
    ? "high"
    : maxScoreSpread !== null && maxScoreSpread > 0
      ? "low"
      : "none";

  // Review is required on high disagreement OR an objective contradiction — the
  // latter can never be auto-resolved. Panel incompleteness alone does not force
  // review (it is a comparability warning), but it never masquerades as
  // confidence.
  const reviewRequired = high;

  return { level, reviewRequired, signals };
}
