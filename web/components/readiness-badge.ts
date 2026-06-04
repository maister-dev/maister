import type { ReadinessState } from "@/lib/flows/graph/readiness-core";

// Per-state readiness badge styling (forest tokens, dark-mode-safe). The single
// source of truth shared by the run-detail ReadinessSummary, the board
// flight-card, and the portfolio project-card so the badge can never drift in
// colour across surfaces. (M15, ADR-048)
export const READINESS_BADGE: Record<ReadinessState, string> = {
  ready: "border-good bg-good-soft text-good",
  blocked:
    "border-red-300 bg-red-50 text-red-700 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300",
  failed:
    "border-red-300 bg-red-50 text-red-700 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300",
  stale: "border-amber-line bg-amber-soft text-amber",
  waiting: "border-amber-line bg-amber-soft text-amber",
  overridden: "border-line bg-ivory text-ink-2",
};
