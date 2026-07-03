// ADR-126 §4.1: the `runs.promotion_hold` jsonb shape. Dependency-free so the
// Drizzle schema can `$type<>` it without importing the evaluation module.

export type PromotionHoldSource = "user" | "system" | "launch";

export interface PromotionHold {
  source: PromotionHoldSource;
  reason?: string;
  createdAt: string;
}
