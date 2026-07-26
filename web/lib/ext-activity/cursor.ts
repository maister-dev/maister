import { MaisterError } from "@/lib/errors";

export const DEFAULT_RUN_ACTIVITY_LIMIT = 100;
export const MAX_RUN_ACTIVITY_LIMIT = 200;

function parseOpaqueBigInt(
  raw: string,
  label: "pulse cursor" | "run activity cursor" | "run activity limit",
): bigint {
  if (!/^\d+$/.test(raw)) {
    throw new MaisterError("CONFIG", `invalid ${label}`);
  }

  return BigInt(raw);
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

export function parseRunSinceId(raw?: string | null): bigint | null {
  if (raw == null || raw.length === 0) return null;

  return parseOpaqueBigInt(raw, "run activity cursor");
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
