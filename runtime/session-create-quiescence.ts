/** Positive host evidence for a create rejection; historical unstamped receipts remain unproven. */
export type SessionCreateQuiescence = Readonly<{
  version: 1;
  process: "not_started" | "terminated";
}>;

export function isSessionCreateQuiescence(
  value: unknown,
): value is SessionCreateQuiescence {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const fields = Object.keys(value);
  const evidence = value as Record<string, unknown>;

  return (
    fields.length === 2 &&
    fields.includes("version") &&
    fields.includes("process") &&
    evidence.version === 1 &&
    (evidence.process === "not_started" || evidence.process === "terminated")
  );
}

export function hasSessionCreateQuiescence(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const details = (value as Record<string, unknown>).details;

  return Boolean(
    details &&
    typeof details === "object" &&
    !Array.isArray(details) &&
    isSessionCreateQuiescence(
      (details as Record<string, unknown>).sessionCreateQuiescence,
    ),
  );
}
