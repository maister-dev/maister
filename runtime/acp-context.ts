export type ContextUsage = Readonly<{ used: number; size: number }>;

export type AcpCompactionStatus =
  "in_progress" | "completed" | "failed" | "cancelled";

export type AcpContextUpdate =
  | ({ kind: "usage" } & ContextUsage)
  | {
      kind: "compaction";
      id: string;
      status: AcpCompactionStatus;
      summary?: string;
      error?: string;
    }
  | { kind: "summary_chunk"; id: string; text: string };

export const ACP_CONTEXT_UPDATE_TYPES = [
  "usage_update",
  "compaction_update",
  "compaction_summary_chunk",
] as const;

type AcpContextUpdateType = (typeof ACP_CONTEXT_UPDATE_TYPES)[number];

const MAX_COMPACTION_ID_LENGTH = 256;
export const MAX_COMPACTION_SUMMARY_LENGTH = 64 * 1024;

export function claudeContextWindow(input: {
  adapter: string | null;
  providerKind: string | null;
  configured: string | null | undefined;
}): {
  configuredWindowTokens: number | null;
  windowAdvisory: "window_unverified" | null;
} {
  if (input.adapter !== "claude")
    return { configuredWindowTokens: null, windowAdvisory: null };
  const requested = input.configured?.trim();
  const parsed =
    requested && /^[1-9]\d*$/.test(requested) ? Number(requested) : NaN;
  const configuredWindowTokens = Number.isSafeInteger(parsed) ? parsed : null;

  return {
    configuredWindowTokens,
    windowAdvisory:
      configuredWindowTokens === null &&
      input.providerKind === "anthropic_compatible"
        ? "window_unverified"
        : null,
  };
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function acpContextUpdateType(
  value: unknown,
): AcpContextUpdateType | null {
  const type = object(value)?.sessionUpdate;

  return (
    ACP_CONTEXT_UPDATE_TYPES.find((candidate) => candidate === type) ?? null
  );
}

/** Cap text in UTF-16 units without splitting a surrogate pair. */
export function clipCompactionText(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const before = text.charCodeAt(limit - 1);
  const after = text.charCodeAt(limit);
  const splitsPair =
    before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;

  return text.slice(0, splitsPair ? limit - 1 : limit);
}

function textBlock(value: unknown): string {
  const block = object(value);

  return block?.type === "text" && typeof block.text === "string"
    ? block.text
    : "";
}

export function decodeAcpContextUpdate(
  value: unknown,
): AcpContextUpdate | null {
  const update = object(value);

  if (!update) return null;
  if (update.sessionUpdate === "usage_update") {
    const { used, size } = update;

    return typeof used === "number" &&
      Number.isSafeInteger(used) &&
      used >= 0 &&
      typeof size === "number" &&
      Number.isSafeInteger(size) &&
      size > 0
      ? { kind: "usage", used, size }
      : null;
  }
  const id = update.compactionId;

  if (
    typeof id !== "string" ||
    !id ||
    id.length > MAX_COMPACTION_ID_LENGTH ||
    /[\u0000\uD800-\uDFFF]/u.test(id)
  )
    return null;
  if (update.sessionUpdate === "compaction_summary_chunk") {
    const text = textBlock(update.content);

    return text ? { kind: "summary_chunk", id, text } : null;
  }
  if (update.sessionUpdate !== "compaction_update") return null;
  const { status } = update;

  if (
    status !== "in_progress" &&
    status !== "completed" &&
    status !== "failed" &&
    status !== "cancelled"
  )
    return null;

  return {
    kind: "compaction",
    id,
    status,
    ...(Array.isArray(update.summary)
      ? { summary: update.summary.map(textBlock).join("") }
      : {}),
    ...(typeof update.error === "string"
      ? { error: clipCompactionText(update.error, 1024) }
      : {}),
  };
}
