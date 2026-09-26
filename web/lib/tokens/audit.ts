import "server-only";

import type { TokenActor } from "@/lib/tokens/verify";

import { eq } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { projectTokens, tokenAuditLog } = schemaModule as unknown as Record<
  string,
  any
>;

// FIXME(any): dual drizzle-orm peer-dep variants.
type Db = any;

export type TokenAuditInput = {
  tokenId: string;
  projectId: string | null;
  actorLabel: string;
  scopeUsed: string;
  endpoint: string;
  method: string;
  result: "ok" | "error";
  statusCode: number;
  // ADR-184: delegated-authority attribution, set for librarian tokens only.
  onBehalfOfUserId?: string | null;
  librarianTurnId?: string | null;
  operationId?: string | null;
};

// The identity half of every audit row a token request writes. A librarian
// token additionally names the human it acted for and the turn that issued it,
// so a route never has to remember to add them.
export function tokenAuditIdentity(
  actor: Pick<TokenActor, "tokenId" | "actorLabel" | "ownerUserId"> & {
    tokenKind: string;
    librarianTurnId?: string | null;
  },
): {
  tokenId: string;
  actorLabel: string;
  onBehalfOfUserId: string | null;
  librarianTurnId: string | null;
} {
  const librarian = actor.tokenKind === "librarian";

  return {
    tokenId: actor.tokenId,
    actorLabel: actor.actorLabel,
    onBehalfOfUserId: librarian ? actor.ownerUserId : null,
    librarianTurnId: librarian ? (actor.librarianTurnId ?? null) : null,
  };
}

/** INSERT one token_audit_log row. */
export async function recordTokenAudit(
  input: TokenAuditInput,
  db?: Db,
): Promise<void> {
  const d = db ?? getDb();

  await d.insert(tokenAuditLog).values({
    token_id: input.tokenId,
    project_id: input.projectId,
    actor_label: input.actorLabel,
    scope_used: input.scopeUsed,
    endpoint: input.endpoint,
    method: input.method,
    result: input.result,
    status_code: input.statusCode,
    on_behalf_of_user_id: input.onBehalfOfUserId ?? null,
    librarian_turn_id: input.librarianTurnId ?? null,
    operation_id: input.operationId ?? null,
  });
}

/** UPDATE project_tokens.last_used_at = now() for the given token. */
export async function bumpTokenLastUsed(
  tokenId: string,
  db?: Db,
): Promise<void> {
  const d = db ?? getDb();

  await d
    .update(projectTokens)
    .set({ last_used_at: new Date() })
    .where(eq(projectTokens.id, tokenId));
}
