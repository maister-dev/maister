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
  "permission_delivery_rejected",
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

export function isPendingHitlDeliveryState(value: unknown): boolean {
  return value === "resume-in-progress" || value === "delivery-in-progress";
}

export function canReplayHitlAnswer(kind: string, schema: unknown): boolean {
  if (kind === "permission" || kind === "form" || kind === "agent_question")
    return true;
  if (kind !== "human") return false;
  if (schema === null || typeof schema !== "object") return true;

  const value = schema as Record<string, unknown>;

  return (
    value.review !== true &&
    value.kind !== "consensus" &&
    value.kind !== "consensus_resolution"
  );
}
