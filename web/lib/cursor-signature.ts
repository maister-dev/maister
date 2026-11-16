import "server-only";

import { createHmac } from "node:crypto";

import { MaisterError } from "@/lib/errors";

/** Domain-separated cursors reuse the configured authentication secret. */
export function cursorSignature(namespace: string, payload: string): Buffer {
  const secret = process.env.AUTH_SECRET;

  if (!secret)
    throw new MaisterError("CONFIG", "AUTH_SECRET is required to sign cursors");

  return createHmac("sha256", secret)
    .update(`${namespace}:${payload}`)
    .digest();
}
