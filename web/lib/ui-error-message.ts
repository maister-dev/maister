import { isMaisterErrorCode } from "@/lib/errors-core";

export { isMaisterErrorCode } from "@/lib/errors-core";

export type UiErrorMessageKey = `error.${string}`;

export function resolveUiErrorMessageKey(value: unknown): UiErrorMessageKey {
  return isMaisterErrorCode(value) ? `error.${value}` : "error.generic";
}

// Codes that refuse an action because server state has moved past what the
// caller's view shows: the row is gone or already closed (PRECONDITION), the
// run left the state the action assumed (CONFLICT — the respond route returns
// it for superseded rows, a terminal or no-longer-awaiting run, and every
// prompt-owner invariant), or the window expired (HITL_TIMEOUT). Retrying the
// same payload against the same screen cannot succeed, so the view must
// re-sync. Deliberately excludes the retryable (EXECUTOR_UNAVAILABLE) and
// validation (NEEDS_INPUT, CONFIG) codes, whose entered payload must survive.
const STALE_VIEW_ERROR_CODES = new Set([
  "CONFLICT",
  "PRECONDITION",
  "HITL_TIMEOUT",
]);

export function isStaleViewErrorCode(value: unknown): boolean {
  return typeof value === "string" && STALE_VIEW_ERROR_CODES.has(value);
}
