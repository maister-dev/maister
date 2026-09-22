export const HITL_RESPOND_REASONS = [
  "permission_resume_in_flight",
  "assignment_fenced",
  "prompt_owner_deferred",
  "prompt_owner_invariant",
  "already_delivered",
  "option_mismatch",
  "not_awaiting_input",
  "agent_session_ended",
  "delivery_unavailable",
] as const;

export type HitlRespondReason = (typeof HITL_RESPOND_REASONS)[number];

export function isHitlRespondReason(
  value: unknown,
): value is HitlRespondReason {
  return (
    typeof value === "string" &&
    (HITL_RESPOND_REASONS as readonly string[]).includes(value)
  );
}

export type HitlPermissionResponse = { optionId: string };
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };
export type HitlStructuredResponse = {
  response: JsonValue;
  confidence?: number;
};
export type HitlStoredResponse =
  | HitlPermissionResponse
  | HitlStructuredResponse;

export type HitlAnswerState = "open" | "answer_stored";
