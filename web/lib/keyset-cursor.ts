import "server-only";

import { timingSafeEqual } from "node:crypto";

import { z } from "zod";

import { cursorSignature } from "@/lib/cursor-signature";
import { MaisterError } from "@/lib/errors";

const cursorSchema = z
  .object({
    version: z.literal(1),
    scope: z.string().length(64),
    upper: z.string().datetime({ precision: 6 }),
    at: z.string().datetime({ precision: 6 }),
    id: z.string().min(1).max(128),
  })
  .strict();

export type KeysetCursor = Readonly<z.infer<typeof cursorSchema>>;

export function signCursorPayload(
  namespace: string,
  value: Readonly<Record<string, unknown>>,
): string {
  const payload = Buffer.from(JSON.stringify(value)).toString("base64url");

  return `${payload}.${cursorSignature(namespace, payload).toString("base64url")}`;
}

export function parseCursorPayload(namespace: string, raw: string): unknown {
  const parts = raw.split(".");

  if (
    raw.length > 2048 ||
    parts.length !== 2 ||
    !parts.every((part) => /^[A-Za-z0-9_-]+$/.test(part))
  )
    throw new MaisterError("CONFIG", "Invalid pagination cursor");
  const expected = cursorSignature(namespace, parts[0]);
  const actual = Buffer.from(parts[1], "base64url");

  if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
    throw new MaisterError("CONFIG", "Invalid pagination cursor signature");

  try {
    return JSON.parse(
      Buffer.from(parts[0], "base64url").toString("utf8"),
    ) as unknown;
  } catch {
    throw new MaisterError("CONFIG", "Invalid pagination cursor payload");
  }
}

export function encodeKeysetCursor(
  namespace: string,
  cursor: KeysetCursor,
): string {
  return signCursorPayload(namespace, cursorSchema.parse(cursor));
}

export function decodeKeysetCursor(
  namespace: string,
  raw: string,
  scope: string,
): KeysetCursor {
  const parsed = cursorSchema.safeParse(parseCursorPayload(namespace, raw));

  if (
    !parsed.success ||
    parsed.data.scope !== scope ||
    parsed.data.at > parsed.data.upper
  )
    throw new MaisterError(
      "CONFIG",
      "Pagination cursor no longer matches this credential, filters or current authority",
    );

  return parsed.data;
}
