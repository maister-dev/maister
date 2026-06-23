import "server-only";

import { and, eq, isNull } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { projectTokens } = schemaModule as unknown as Record<string, any>;

// FIXME(any): dual drizzle-orm peer-dep variants.
type Db = any;

export type RevokeOutcome = "revoked" | "already-revoked" | "not-found";

/**
 * Revoke a token by setting revoked_at = now().
 * project_id predicate hides cross-project tokens as "not-found".
 */
export async function revokeToken(
  input: { tokenId: string; projectId: string },
  db?: Db,
): Promise<{ outcome: RevokeOutcome }> {
  const d = db ?? getDb();

  const rows = await d
    .select()
    .from(projectTokens)
    .where(
      and(
        eq(projectTokens.id, input.tokenId),
        eq(projectTokens.project_id, input.projectId),
      ),
    )
    .limit(1);

  if (rows.length === 0) {
    return { outcome: "not-found" };
  }

  const row = rows[0];

  if (row.revoked_at !== null && row.revoked_at !== undefined) {
    return { outcome: "already-revoked" };
  }

  // CAS: only update if revoked_at IS NULL (handles concurrent calls).
  // project_id is re-asserted in the predicate (defence-in-depth: never mutate
  // a token outside the caller's project even though the SELECT above scoped it).
  await d
    .update(projectTokens)
    .set({ revoked_at: new Date() })
    .where(
      and(
        eq(projectTokens.id, input.tokenId),
        eq(projectTokens.project_id, input.projectId),
        isNull(projectTokens.revoked_at),
      ),
    );

  return { outcome: "revoked" };
}

/**
 * Revoke a global personal token owned by a specific user. The owner and
 * project_id predicates hide other users' tokens and project-bound tokens as
 * "not-found".
 */
export async function revokeOwnerToken(
  input: { tokenId: string; ownerUserId: string },
  db?: Db,
): Promise<{ outcome: RevokeOutcome }> {
  const d = db ?? getDb();

  const rows = await d
    .select()
    .from(projectTokens)
    .where(
      and(
        eq(projectTokens.id, input.tokenId),
        eq(projectTokens.owner_user_id, input.ownerUserId),
        eq(projectTokens.token_kind, "user"),
        isNull(projectTokens.project_id),
      ),
    )
    .limit(1);

  if (rows.length === 0) {
    return { outcome: "not-found" };
  }

  const row = rows[0];

  if (row.revoked_at !== null && row.revoked_at !== undefined) {
    return { outcome: "already-revoked" };
  }

  await d
    .update(projectTokens)
    .set({ revoked_at: new Date() })
    .where(
      and(
        eq(projectTokens.id, input.tokenId),
        eq(projectTokens.owner_user_id, input.ownerUserId),
        eq(projectTokens.token_kind, "user"),
        isNull(projectTokens.project_id),
        isNull(projectTokens.revoked_at),
      ),
    );

  return { outcome: "revoked" };
}
