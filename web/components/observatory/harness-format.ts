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
