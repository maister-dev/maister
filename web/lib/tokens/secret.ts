import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** sha256 hex of the given string. Never logs or returns the input. */
export function hashToken(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

/** First 12 characters of the token string (prefix index key). */
export function tokenPrefix(secret: string): string {
  return secret.slice(0, 12);
}

/**
 * Constant-time comparison of two hex strings.
 * Returns false (never throws) on length mismatch.
 */
export function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;

  // timingSafeEqual requires equal-length ArrayBufferView.
  try {
    const enc = new TextEncoder();

    return timingSafeEqual(enc.encode(a), enc.encode(b));
  } catch {
    return false;
  }
}

/**
 * Generate a new project API token.
 * secret = "mai_" + base64url(randomBytes(32))
 * prefix = first 12 chars of secret
 * hash   = sha256hex(secret)  — the ONLY value stored in DB
 */
export function generateToken(): {
  secret: string;
  prefix: string;
  hash: string;
} {
  const raw = randomBytes(32).toString("base64url");
  const secret = `mai_${raw}`;
  const prefix = tokenPrefix(secret);
  const hash = hashToken(secret);

  return { secret, prefix, hash };
}
