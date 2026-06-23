import "server-only";

import type { TokenKind } from "@/lib/tokens/issue";

import { and, desc, eq, isNull } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { projectTokens, users } = schemaModule as unknown as Record<string, any>;

// FIXME(any): dual drizzle-orm peer-dep variants.
type Db = any;

export type TokenListItem = {
  id: string;
  name: string;
  kind: TokenKind;
  ownerUserId: string | null;
  ownerLabel: string | null;
  scopes: string[];
  prefix: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
};

/**
 * List all tokens for a project. Ordered by created_at DESC.
 * NEVER selects or returns token_hash.
 */
export async function listTokens(
  projectId: string,
  db?: Db,
): Promise<TokenListItem[]> {
  const d = db ?? getDb();

  const rows = await d
    .select({
      id: projectTokens.id,
      name: projectTokens.name,
      kind: projectTokens.token_kind,
      ownerUserId: projectTokens.owner_user_id,
      ownerName: users.name,
      ownerEmail: users.email,
      scopes: projectTokens.scopes,
      prefix: projectTokens.prefix,
      createdAt: projectTokens.created_at,
      lastUsedAt: projectTokens.last_used_at,
      expiresAt: projectTokens.expires_at,
      revokedAt: projectTokens.revoked_at,
    })
    .from(projectTokens)
    .leftJoin(users, eq(projectTokens.owner_user_id, users.id))
    .where(eq(projectTokens.project_id, projectId))
    .orderBy(desc(projectTokens.created_at));

  return rows.map(
    (r: any): TokenListItem => ({
      id: r.id,
      name: r.name,
      kind: r.kind ?? "project",
      ownerUserId: r.ownerUserId ?? null,
      ownerLabel: r.ownerName ?? r.ownerEmail ?? null,
      scopes: (r.scopes as string[]) ?? ["*"],
      prefix: r.prefix,
      createdAt: r.createdAt,
      lastUsedAt: r.lastUsedAt ?? null,
      expiresAt: r.expiresAt ?? null,
      revokedAt: r.revokedAt ?? null,
    }),
  );
}

/**
 * List global personal tokens for an account owner. Ordered by created_at DESC.
 * NEVER selects or returns token_hash.
 */
export async function listOwnerTokens(
  ownerUserId: string,
  db?: Db,
): Promise<TokenListItem[]> {
  const d = db ?? getDb();

  const rows = await d
    .select({
      id: projectTokens.id,
      name: projectTokens.name,
      kind: projectTokens.token_kind,
      ownerUserId: projectTokens.owner_user_id,
      ownerName: users.name,
      ownerEmail: users.email,
      scopes: projectTokens.scopes,
      prefix: projectTokens.prefix,
      createdAt: projectTokens.created_at,
      lastUsedAt: projectTokens.last_used_at,
      expiresAt: projectTokens.expires_at,
      revokedAt: projectTokens.revoked_at,
    })
    .from(projectTokens)
    .leftJoin(users, eq(projectTokens.owner_user_id, users.id))
    .where(
      and(
        eq(projectTokens.owner_user_id, ownerUserId),
        eq(projectTokens.token_kind, "user"),
        isNull(projectTokens.project_id),
      ),
    )
    .orderBy(desc(projectTokens.created_at));

  return rows.map(
    (r: any): TokenListItem => ({
      id: r.id,
      name: r.name,
      kind: r.kind ?? "user",
      ownerUserId: r.ownerUserId ?? null,
      ownerLabel: r.ownerName ?? r.ownerEmail ?? null,
      scopes: (r.scopes as string[]) ?? ["*"],
      prefix: r.prefix,
      createdAt: r.createdAt,
      lastUsedAt: r.lastUsedAt ?? null,
      expiresAt: r.expiresAt ?? null,
      revokedAt: r.revokedAt ?? null,
    }),
  );
}
