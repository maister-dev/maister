export type UnsupportedAcpMessage = Readonly<{
  acpMessageKind: "request" | "notification";
  acpMethod?: string;
}>;

/** Keep only bounded JSON-RPC envelope metadata, including at read boundaries. */
export function parseUnsupportedAcpMessage(
  value: unknown,
): UnsupportedAcpMessage | undefined {
  if (!value || typeof value !== "object" || !("acpMessageKind" in value))
    return undefined;
  const { acpMessageKind } = value;

  if (acpMessageKind !== "request" && acpMessageKind !== "notification")
    return undefined;
  const method = "acpMethod" in value ? value.acpMethod : undefined;

  return {
    acpMessageKind,
    ...(typeof method === "string" &&
    method.length <= 128 &&
    /^[A-Za-z_][A-Za-z0-9_.-]*(\/[A-Za-z0-9_.-]+)*$/.test(method)
      ? { acpMethod: method }
      : {}),
  };
}

export function readUnsupportedAcpMessage(
  error: unknown,
): UnsupportedAcpMessage | undefined {
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
    "outputFailure" in details &&
    details.outputFailure === "producer_method_unsupported"
    ? parseUnsupportedAcpMessage(details)
    : undefined;
}
