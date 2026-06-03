import "server-only";

import { desc, eq } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { projectTokens } = schemaModule as unknown as Record<string, any>;

// FIXME(any): dual drizzle-orm peer-dep variants.
type Db = any;

export type TokenListItem = {
  id: string;
  name: string;
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
      prefix: projectTokens.prefix,
      createdAt: projectTokens.created_at,
      lastUsedAt: projectTokens.last_used_at,
      expiresAt: projectTokens.expires_at,
      revokedAt: projectTokens.revoked_at,
    })
    .from(projectTokens)
    .where(eq(projectTokens.project_id, projectId))
    .orderBy(desc(projectTokens.created_at));

  return rows.map(
    (r: any): TokenListItem => ({
      id: r.id,
      name: r.name,
      prefix: r.prefix,
      createdAt: r.createdAt,
      lastUsedAt: r.lastUsedAt ?? null,
      expiresAt: r.expiresAt ?? null,
      revokedAt: r.revokedAt ?? null,
    }),
  );
}
