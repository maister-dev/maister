import "server-only";

import { MaisterError } from "@/lib/errors";

export function databaseTimestamp(value: unknown): string | null {
  if (value === null) return null;
  if (!(value instanceof Date) && typeof value !== "string")
    throw new MaisterError("CONFIG", "Stored database timestamp is invalid");
  const parsed = new Date(value);

  if (!Number.isFinite(parsed.getTime()))
    throw new MaisterError("CONFIG", "Stored database timestamp is invalid");

  return parsed.toISOString();
}
