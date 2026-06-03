import "server-only";

import { eq } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { hashToken, safeEqualHex, tokenPrefix } from "@/lib/tokens/secret";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { projectTokens } = schemaModule as unknown as Record<string, any>;

// FIXME(any): dual drizzle-orm peer-dep variants.
type Db = any;

export type TokenAuthKind = "invalid" | "expired" | "revoked" | "wrong-project";

export class TokenAuthError extends Error {
  readonly kind: TokenAuthKind;
  readonly tokenId?: string;
  readonly projectId?: string;

  constructor(
    kind: TokenAuthKind,
    message?: string,
    meta?: { tokenId?: string; projectId?: string },
  ) {
    super(message ?? kind);
    this.name = "TokenAuthError";
    this.kind = kind;
    this.tokenId = meta?.tokenId;
    this.projectId = meta?.projectId;
  }
}

export type TokenActor = {
  tokenId: string;
  projectId: string;
  actorLabel: string;
  scopes: string[];
};

/**
 * Verify a presented token string against the DB.
 * Lookup by prefix → timingSafeEqual hash check → revocation → expiry.
 * Throws TokenAuthError; NEVER logs the secret or hash.
 */
export async function verifyToken(
  presented: string,
  db?: Db,
): Promise<TokenActor> {
  const d = db ?? getDb();
  const prefix = tokenPrefix(presented);

  // The 12-char prefix carries ~48 bits of random entropy, so prefix
  // collisions are statistically impossible in any realistic token population;
  // the limit is a defensive cap, and the hash compare below still gates a match.
  const rows = await d
    .select()
    .from(projectTokens)
    .where(eq(projectTokens.prefix, prefix))
    .limit(10);

  // Find the matching row via constant-time hash compare.
  const presentedHash = hashToken(presented);
  const row = rows.find((r: any) => safeEqualHex(presentedHash, r.token_hash));

  if (!row) {
    throw new TokenAuthError("invalid");
  }

  if (row.revoked_at !== null && row.revoked_at !== undefined) {
    throw new TokenAuthError("revoked", undefined, {
      tokenId: row.id,
      projectId: row.project_id,
    });
  }

  if (
    row.expires_at !== null &&
    row.expires_at !== undefined &&
    row.expires_at <= new Date()
  ) {
    throw new TokenAuthError("expired", undefined, {
      tokenId: row.id,
      projectId: row.project_id,
    });
  }

  return {
    tokenId: row.id,
    projectId: row.project_id,
    actorLabel: `token:${row.name}`,
    scopes: (row.scopes as string[]) ?? ["*"],
  };
}

/** Map TokenAuthKind to HTTP status code. */
export function httpStatusForTokenAuth(kind: TokenAuthKind): number {
  switch (kind) {
    case "wrong-project":
      return 404;
    default:
      return 401;
  }
}
