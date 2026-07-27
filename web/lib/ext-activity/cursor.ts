import { MaisterError } from "@/lib/errors";

export const DEFAULT_RUN_ACTIVITY_LIMIT = 100;
export const MAX_RUN_ACTIVITY_LIMIT = 200;
const MAX_CURSOR_BIGINT = 9_223_372_036_854_775_807n;

export type RunActivityCursor = {
  lastMutationId: bigint;
  lastItemId: string | null;
};

function parseOpaqueBigInt(
  raw: string,
  label: "pulse cursor" | "run activity cursor" | "run activity limit",
): bigint {
  if (!/^\d+$/.test(raw)) {
    throw new MaisterError("CONFIG", `invalid ${label}`);
  }

  const parsed = BigInt(raw);

  if (parsed > MAX_CURSOR_BIGINT) {
    throw new MaisterError("CONFIG", `invalid ${label}`);
  }

  return parsed;
}

export function encodePulseCursor(eventId: number | bigint): string {
  return BigInt(eventId).toString(10);
}

export function parsePulseCursor(raw?: string | null): bigint | null {
  if (raw == null || raw.length === 0) return null;

  return parseOpaqueBigInt(raw, "pulse cursor");
}

export function encodeRunSinceId(mutationId: number | bigint): string {
  return BigInt(mutationId).toString(10);
}

export function encodeRunActivityCursor(cursor: RunActivityCursor): string {
  if (cursor.lastItemId === null) {
    return encodeRunSinceId(cursor.lastMutationId);
  }

  return `${encodeRunSinceId(cursor.lastMutationId)}:${encodeURIComponent(cursor.lastItemId)}`;
}

export function parseRunSinceId(raw?: string | null): RunActivityCursor | null {
  if (raw == null || raw.length === 0) return null;

  const separatorIndex = raw.indexOf(":");

  if (separatorIndex < 0) {
    return {
      lastMutationId: parseOpaqueBigInt(raw, "run activity cursor"),
      lastItemId: null,
    };
  }

  const mutationIdRaw = raw.slice(0, separatorIndex);
  const encodedItemId = raw.slice(separatorIndex + 1);

  if (encodedItemId.length === 0) {
    throw new MaisterError("CONFIG", "invalid run activity cursor");
  }

  let lastItemId: string;

  try {
    lastItemId = decodeURIComponent(encodedItemId);
  } catch {
    throw new MaisterError("CONFIG", "invalid run activity cursor");
  }

  if (lastItemId.length === 0) {
    throw new MaisterError("CONFIG", "invalid run activity cursor");
  }

  return {
    lastMutationId: parseOpaqueBigInt(mutationIdRaw, "run activity cursor"),
    lastItemId,
  };
}

export function parseRunActivityLimit(raw?: string | null): number {
  if (raw == null || raw.length === 0) return DEFAULT_RUN_ACTIVITY_LIMIT;
  const parsed = parseOpaqueBigInt(raw, "run activity limit");

  if (
    parsed < 1n ||
    parsed > BigInt(MAX_RUN_ACTIVITY_LIMIT) ||
    parsed > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    throw new MaisterError("CONFIG", "invalid run activity limit");
  }

  return Number(parsed);
}
