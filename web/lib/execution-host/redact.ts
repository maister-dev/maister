// Ledger payload redaction (ADR-166 E-EH-12). The `execution_commands.payload`
// column keeps enough of a command to explain and replay it — kind-specific
// ids, session names, adapter/model — but NEVER a prompt body, an env value, or
// a secret-looking value. Applied once, at insert, by the ledger.

const SECRET_KEY = /token|secret|key|password|authorization|credential/i;

// Keys that match SECRET_KEY lexically but carry identifiers, not secrets.
const SAFE_KEYS = new Set([
  "hostKey",
  "envKeys",
  "headerKeys",
  "slotKey",
  "taskKey",
  "addressableKey",
  "idempotencyKey",
  "requestKey",
]);

const MAX_DEPTH = 8;

export const REDACTED = "[REDACTED]";

function redactValue(key: string, value: unknown, depth: number): unknown {
  if (key === "prompt" && typeof value === "string") return undefined;

  if (
    key === "env" &&
    value &&
    typeof value === "object" &&
    !Array.isArray(value)
  ) {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>).map((k) => [k, REDACTED]),
    );
  }

  if (SECRET_KEY.test(key) && !SAFE_KEYS.has(key)) {
    return REDACTED;
  }

  return redactNode(value, depth + 1);
}

function redactNode(value: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) return REDACTED;
  if (Array.isArray(value)) return value.map((v) => redactNode(v, depth + 1));
  if (!value || typeof value !== "object") return value;

  const out: Record<string, unknown> = {};

  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    if (key === "prompt" && typeof inner === "string") {
      out.promptBytes = Buffer.byteLength(inner, "utf8");
      continue;
    }

    if (key === "contentBlocks" && Array.isArray(inner)) {
      out.contentBlockCount = inner.length;
      continue;
    }

    const redacted = redactValue(key, inner, depth);

    if (redacted !== undefined) out[key] = redacted;
  }

  return out;
}

export function redactPayload(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return {};
  }

  return redactNode(payload, 0) as Record<string, unknown>;
}
