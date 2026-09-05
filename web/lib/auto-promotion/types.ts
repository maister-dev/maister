// ADR-126 §4.1: the `runs.promotion_hold` jsonb shape. Dependency-free so the
// Drizzle schema can `$type<>` it without importing the evaluation module.

// `evaluation_study` (ADR-146 D15): the forced hold on a launched evaluation
// participant. Written by the controlled-launch path and the launched-participant
// restart path; DELETE /api/runs/[runId]/promotion-hold refuses to clear it while
// the owning study is still live.
export type PromotionHoldSource =
  | "user"
  | "system"
  | "launch"
  | "evaluation_study";

export interface PromotionHold {
  source: PromotionHoldSource;
  reason?: string;
  createdAt: string;
}
