import "server-only";

import type { TokenKind } from "@/lib/tokens/issue";

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
  tokenKind: TokenKind;
  ownerUserId: string | null;
  agentId: string | null;
  actorLabel: string;
  scopes: string[];
  // M37 (ADR-098): the run a per-launch ephemeral token is bound to, derived
  // SERVER-SIDE from the deterministic token name (`orchestrator-run:<id>` or
  // `agent-run:<id>`). A delegation route reads the PARENT runId from here,
  // never from the request body.
  boundRunId: string | null;
};

// M37 (ADR-098): the run id baked into a per-launch ephemeral token's
// deterministic name. Returns null for any other token (durable project tokens,
// user tokens) — they are not run-bound.
export function parseBoundRunId(name: string): string | null {
  const match = /^(?:orchestrator-run|agent-run):(.+)$/.exec(name);

  return match ? match[1] : null;
}

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

  const tokenKind: TokenKind = row.token_kind ?? "project";
  const agentId: string | null = row.agent_id ?? null;

  return {
    tokenId: row.id,
    projectId: row.project_id,
    tokenKind,
    ownerUserId: row.owner_user_id ?? null,
    agentId,
    // ADR-089: agent tokens carry the agent identity into token_audit_log.
    actorLabel:
      tokenKind === "agent" && agentId
        ? `agent:${agentId}`
        : `token:${row.name}`,
    scopes: (row.scopes as string[]) ?? ["*"],
    boundRunId: parseBoundRunId(row.name ?? ""),
  };
}

export function actorUserIdForToken(actor: TokenActor): string | null {
  return actor.tokenKind === "user" ? actor.ownerUserId : null;
}

// Token → polymorphic social actor (ADR-083/ADR-089): agent tokens act as the
// agent, user-owned tokens act as that user, ownerless project tokens act as
// system. Shape matches lib/social/activity.ts SocialActor structurally.
export function socialActorForToken(
  actor: TokenActor,
):
  | { type: "user"; id: string }
  | { type: "agent"; id: string }
  | { type: "system"; id: null } {
  if (actor.tokenKind === "agent" && actor.agentId) {
    return { type: "agent", id: actor.agentId };
  }

  if (actor.tokenKind === "user" && actor.ownerUserId) {
    return { type: "user", id: actor.ownerUserId };
  }

  return { type: "system", id: null };
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
