// Client-safe (pure): strict validation of a submitted judge result against the
// method criteria (ADR-145 D12). Invalid output produces a TERMINAL INVALID
// attempt (a distinct outcome) — never a partial row masquerading as valid, and
// a missing criterion NEVER becomes numeric zero. Fail-closed: an out-of-range
// score is invalid, not clamped (a range on the producer side does not hold for
// untrusted agent stdout).

import type { EvaluationCriterionState } from "@/lib/evaluations/types";

export interface JudgeCriterionSpec {
  id: string;
  scaleMin: number;
  scaleMax: number;
  // When true, an entirely-absent criterion is an INVALID attempt; when false it
  // degrades to insufficient_evidence (honest, never zero).
  required: boolean;
}

export interface SubmittedCriterion {
  state?: EvaluationCriterionState;
  score?: number | null;
  rationale?: string | null;
  confidence?: number | null;
  evidenceRefs?: string[];
  objectiveRefs?: string[];
}

export interface ValidatedCriterion {
  criterionId: string;
  state: EvaluationCriterionState;
  score: number | null;
  rationale: string | null;
  confidence: number | null;
  evidenceRefs: string[];
  objectiveRefs: string[];
}

export type JudgeResultValidation =
  | { valid: true; criteria: ValidatedCriterion[] }
  | { valid: false; violations: string[] };

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

// Validate the submitted per-criterion body. Unknown criterion ids, out-of-range
// scores, a scored state with no finite score, and out-of-[0,1] confidence are
// all INVALID (fail-closed). Absent non-required criteria become
// insufficient_evidence with a null score.
export function validateJudgeResult(
  submitted: Record<string, SubmittedCriterion>,
  criteria: JudgeCriterionSpec[],
): JudgeResultValidation {
  const violations: string[] = [];
  const validCriterionIds = new Set(criteria.map((c) => c.id));

  for (const key of Object.keys(submitted)) {
    if (!validCriterionIds.has(key)) {
      violations.push(`unknown criterion "${key}"`);
    }
  }

  const result: ValidatedCriterion[] = [];

  for (const spec of criteria) {
    const cell = submitted[spec.id];

    if (!cell) {
      if (spec.required) {
        violations.push(`required criterion "${spec.id}" is missing`);
      }
      result.push({
        criterionId: spec.id,
        state: "insufficient_evidence",
        score: null,
        rationale: null,
        confidence: null,
        evidenceRefs: [],
        objectiveRefs: [],
      });
      continue;
    }

    const state: EvaluationCriterionState = cell.state ?? "scored";

    if (
      state !== "scored" &&
      state !== "insufficient_evidence" &&
      state !== "not_applicable"
    ) {
      violations.push(`criterion "${spec.id}" has an invalid state "${state}"`);
    }

    let score: number | null = null;

    if (state === "scored") {
      if (!isFiniteNumber(cell.score)) {
        violations.push(
          `criterion "${spec.id}" is scored but has no finite score`,
        );
      } else if (cell.score < spec.scaleMin || cell.score > spec.scaleMax) {
        violations.push(
          `criterion "${spec.id}" score ${cell.score} is outside [${spec.scaleMin}, ${spec.scaleMax}]`,
        );
      } else {
        score = cell.score;
      }
    }

    if (
      cell.confidence !== undefined &&
      cell.confidence !== null &&
      (!isFiniteNumber(cell.confidence) ||
        cell.confidence < 0 ||
        cell.confidence > 1)
    ) {
      violations.push(
        `criterion "${spec.id}" confidence must be within [0, 1]`,
      );
    }

    result.push({
      criterionId: spec.id,
      state,
      score,
      rationale: cell.rationale ?? null,
      confidence: cell.confidence ?? null,
      evidenceRefs: cell.evidenceRefs ?? [],
      objectiveRefs: cell.objectiveRefs ?? [],
    });
  }

  if (violations.length > 0) return { valid: false, violations };

  return { valid: true, criteria: result };
}
