import { readApiError } from "@/lib/api-error";

const CREATE_FLOW_CONFLICT_REASONS = [
  "duplicate_flow_id",
  "edit_lock_not_held",
  "assistant_active",
  "creation_recovery_required",
  "operation_in_progress",
] as const;

type CreateFlowConflictReason = (typeof CREATE_FLOW_CONFLICT_REASONS)[number];

type Translate = (key: string) => string;

function isCreateFlowConflictReason(
  value: unknown,
): value is CreateFlowConflictReason {
  return (
    typeof value === "string" &&
    (CREATE_FLOW_CONFLICT_REASONS as readonly string[]).includes(value)
  );
}

// Only this Flow-specific surface interprets the small, server-approved reason
// enum. Generic API consumers continue to ignore error details so raw service
// messages and arbitrary detail payloads never reach the browser.
export async function readCreateFlowApiError(
  response: Response,
  tApiErrors: Translate,
  tCreateFlow: Translate,
): Promise<string> {
  const body = (await response
    .clone()
    .json()
    .catch(() => null)) as {
    details?: { reason?: unknown };
  } | null;
  const reason = body?.details?.reason;

  if (isCreateFlowConflictReason(reason)) {
    return tCreateFlow(`errors.${reason}`);
  }

  return readApiError(response, tApiErrors);
}
