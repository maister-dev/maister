import "server-only";

import type { SqlTransaction } from "@/lib/db/sql-types";

import { tokenHasScope } from "./scopes";

import { lockCurrentNativeKnowledgeToken } from "@/lib/brain/knowledge-token-lock";
import { MaisterError } from "@/lib/errors";

export type PersonalKnowledgeCredential = Readonly<{
  tokenId: string;
  userId: string;
}>;

export async function lockPersonalKnowledgeCredential(
  db: SqlTransaction,
  credential: PersonalKnowledgeCredential,
  scope: string,
): Promise<readonly string[]> {
  const token = await lockCurrentNativeKnowledgeToken(db, credential.tokenId);

  if (
    token.token_kind !== "user" ||
    token.project_id !== null ||
    token.owner_user_id !== credential.userId ||
    !tokenHasScope(token.scopes, scope)
  )
    throw new MaisterError(
      "UNAUTHORIZED",
      "A current global personal token with the required scope is required",
    );

  return token.scopes;
}
