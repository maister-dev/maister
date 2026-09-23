import { isMaisterErrorCode } from "@/lib/errors-core";
import {
  isHitlRespondReason,
  type HitlAnswerState,
  type HitlRespondReason,
} from "@/lib/hitl-response-contract";

export { isMaisterErrorCode } from "@/lib/errors-core";

export type UiErrorMessageKey = `error.${string}`;

export function resolveUiErrorMessageKey(value: unknown): UiErrorMessageKey {
  return isMaisterErrorCode(value) ? `error.${value}` : "error.generic";
}

export type HitlErrorMessage = {
  key: `error.${string}` | `errorReasons.${string}`;
  values?: { answerState: HitlAnswerState };
  causeCode?: string;
};

const REASON_CODES: Record<HitlRespondReason, string> = {
  permission_resume_in_flight: "CONFLICT",
  assignment_fenced: "CONFLICT",
  prompt_owner_deferred: "PRECONDITION",
  prompt_owner_invariant: "CONFLICT",
  already_delivered: "CONFLICT",
  option_mismatch: "CONFLICT",
  not_awaiting_input: "CONFLICT",
  agent_session_ended: "HITL_TIMEOUT",
  delivery_unavailable: "EXECUTOR_UNAVAILABLE",
  permission_delivery_rejected: "HITL_TIMEOUT",
};

export function resolveHitlErrorMessage(input: {
  code?: unknown;
  details?: { reason?: unknown; causeCode?: unknown } | null;
  surface?: "flow" | "scratch";
  answerState?: HitlAnswerState;
}): HitlErrorMessage {
  const { code, details, surface = "flow", answerState = "open" } = input;
  const reason = details?.reason;

  if (isHitlRespondReason(reason) && REASON_CODES[reason] === code) {
    const key =
      surface === "scratch" &&
      (reason === "agent_session_ended" ||
        reason === "permission_delivery_rejected")
        ? (`errorReasons.${reason}_scratch` as const)
        : (`errorReasons.${reason}` as const);
    const causeCode = details?.causeCode;

    return {
      key,
      ...(reason.startsWith("prompt_owner_") &&
      typeof causeCode === "string" &&
      /^[a-z][a-z0-9_]{0,63}$/.test(causeCode)
        ? { causeCode }
        : {}),
    };
  }

  if (code === "EXECUTOR_UNAVAILABLE") {
    return {
      key: "error.EXECUTOR_UNAVAILABLE_HITL",
      values: { answerState },
    };
  }

  return { key: resolveUiErrorMessageKey(code) };
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
