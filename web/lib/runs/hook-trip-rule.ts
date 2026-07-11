// Pure guardrail-halt rule mapping — no server-only / DB deps, so consumers can
// import it without pulling in the escalation machinery (and unit tests that mock
// `@/lib/runs/hook-trip` keep the real mapper). ADR-108 (M40) + ADR-129.

// The liveness breakers (repetition / no_progress) and the ADR-129 capability_guard
// N-deny breaker HALT and reach the escalate path; a per-call `path_guard` /
// `capability_guard` deny is deny-and-continue (never escalates).
export type HookTripHaltRule =
  | "repetition"
  | "no_progress"
  | "capability_guard";

// Map a supervisor `session.hook_trip` rule to the halting rule carried on the
// escalation. The supervisor only ever emits a `halt` disposition for the three
// HookTripHaltRule values; `path_guard` is deny-only and should never reach here,
// but is folded to `repetition` so a stray event can't crash escalation. Exhaustive
// switch (no default) → a future halt rule is a compile error, not a silent
// mis-label. Single source of truth for the flow + agent + scratch consumers.
export function haltRuleFromEvent(
  rule: "path_guard" | "repetition" | "no_progress" | "capability_guard",
): HookTripHaltRule {
  switch (rule) {
    case "no_progress":
      return "no_progress";
    case "capability_guard":
      return "capability_guard";
    case "repetition":
    case "path_guard":
      return "repetition";
  }
}
