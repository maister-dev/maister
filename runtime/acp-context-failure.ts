export const ACP_CONTEXT_FAILURE_REASONS = [
  "context_exhausted",
  "max_output_tokens",
] as const;

export type AcpContextFailureReason =
  (typeof ACP_CONTEXT_FAILURE_REASONS)[number];

export function isAcpContextFailureReason(
  value: unknown,
): value is AcpContextFailureReason {
  return value === "context_exhausted" || value === "max_output_tokens";
}

export function acpContextFailureReason(
  error: unknown,
): AcpContextFailureReason | undefined {
  if (
    !error ||
    typeof error !== "object" ||
    !("code" in error) ||
    error.code !== "ACP_PROTOCOL" ||
    !("details" in error)
  )
    return undefined;
  const { details } = error;

  return details &&
    typeof details === "object" &&
    "reason" in details &&
    isAcpContextFailureReason(details.reason)
    ? details.reason
    : undefined;
}

export function promptContextFailureReason(
  outcome:
    | { state: "succeeded"; response: { stopReason?: unknown } }
    | { state: "failed" | "fenced"; error: unknown },
): AcpContextFailureReason | undefined {
  if (outcome.state === "succeeded")
    return outcome.response.stopReason === "max_tokens"
      ? "max_output_tokens"
      : undefined;

  return outcome.state === "failed"
    ? acpContextFailureReason(outcome.error)
    : undefined;
}
