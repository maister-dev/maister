import "server-only";

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { z } from "zod";

import { MaisterError } from "@/lib/errors";

const cursorSchema = z.tuple([
  z.literal(1),
  z.string().length(22),
  z.string().datetime({ precision: 6 }),
  z.string().datetime({ precision: 6 }),
  z.string().min(1).max(256),
]);

export type AgentActivityCursor = {
  upper: string;
  at: string;
  id: string;
};

function cursorSignature(payload: string): Buffer {
  const secret = process.env.AUTH_SECRET;

  if (!secret)
    throw new MaisterError(
      "CONFIG",
      "AUTH_SECRET is required to sign agent history cursors",
    );

  return createHmac("sha256", secret)
    .update(`maister.agent-activity.v1:${payload}`)
    .digest();
}

function cursorScope(scope: string): string {
  return createHash("sha256")
    .update(scope)
    .digest()
    .subarray(0, 16)
    .toString("base64url");
}

export function encodeAgentActivityCursor(
  scope: string,
  cursor: AgentActivityCursor,
): string {
  const payload = Buffer.from(
    JSON.stringify([1, cursorScope(scope), cursor.upper, cursor.at, cursor.id]),
  ).toString("base64url");

  return `${payload}.${cursorSignature(payload).toString("base64url")}`;
}

export function decodeAgentActivityCursor(
  scope: string,
  raw: string,
): AgentActivityCursor {
  const parts = raw.split(".");

  if (
    raw.length > 2048 ||
    parts.length !== 2 ||
    !parts.every((part) => /^[A-Za-z0-9_-]+$/.test(part))
  ) {
    throw new MaisterError("CONFIG", "Invalid agent history cursor");
  }
  const expected = cursorSignature(parts[0]);
  const signature = Buffer.from(parts[1], "base64url");

  if (
    signature.length !== expected.length ||
    !timingSafeEqual(signature, expected)
  ) {
    throw new MaisterError("CONFIG", "Invalid agent history cursor signature");
  }
  let value: unknown;

  try {
    value = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
  } catch {
    throw new MaisterError("CONFIG", "Invalid agent history cursor payload");
  }
  const parsed = cursorSchema.safeParse(value);

  if (
    !parsed.success ||
    parsed.data[1] !== cursorScope(scope) ||
    parsed.data[3] > parsed.data[2]
  ) {
    throw new MaisterError(
      "CONFIG",
      "Agent history cursor does not match this project, agent or filters",
    );
  }

  return { upper: parsed.data[2], at: parsed.data[3], id: parsed.data[4] };
}
