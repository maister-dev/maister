import { MIN_GROUP_EXECUTIONS } from "@/lib/queries/observatory-core";

// ADR-073 honest-N rule: every rate renders WITH its denominator, and a group
// below MIN_GROUP_EXECUTIONS renders an em-dash, never 0%.
export function formatRateWithN(rate: number | null, n: number): string {
  if (rate === null || n < MIN_GROUP_EXECUTIONS) return `— (n=${n})`;

  return `${Math.round(rate * 100)}% (n=${n})`;
}

export function formatRatioWithN(value: number, n: number): string {
  if (n < MIN_GROUP_EXECUTIONS) return `— (n=${n})`;

  return `${value.toFixed(2)} (n=${n})`;
}

/**
 * A wait/elapsed duration, in the Observatory's compact `s` / `m` / `h` form.
 *
 * Shared so the Autonomy Score card and the quality tables — which render the
 * SAME `autonomy.waitSeconds` field — cannot round it two different ways.
 */
export function formatSeconds(value: number): string {
  if (value < 60) return `${value}s`;

  const minutes = Math.round(value / 60);

  if (minutes < 60) return `${minutes}m`;

  return `${Math.round(minutes / 60)}h`;
}

export function formatLift(
  lift: number | null,
  failedN: number,
  passedN: number,
): string {
  if (
    lift === null ||
    failedN < MIN_GROUP_EXECUTIONS ||
    passedN < MIN_GROUP_EXECUTIONS
  ) {
    return "—";
  }

  return `${lift.toFixed(2)}×`;
}
