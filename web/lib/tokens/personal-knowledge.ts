import "server-only";

import type { NextResponse } from "next/server";
import type { Db } from "@/lib/execution-host/db";

import { handleOwnedExt } from "./owned-ext-handler";
import { tokenHasScope } from "./scopes";

import { lockCurrentNativeKnowledgeToken } from "@/lib/brain/knowledge-token-lock";
import { vaultErrorResponse } from "@/lib/agent-memory-vault/http";
import { MaisterError } from "@/lib/errors";

export type PersonalKnowledgeCredential = Readonly<{
  tokenId: string;
  userId: string;
}>;
type ReviewKind = "brain" | "vault" | "knowledge";
const reviewScopes = {
  brain: "memory:read",
  vault: "agent_memory:read",
  knowledge: "knowledge:read",
} as const;
const reviewKinds = ["brain", "vault", "knowledge"] as const;

export function visibleReviewKinds(
  scopes: readonly string[],
): readonly ReviewKind[] {
  return reviewKinds.filter((kind) =>
    tokenHasScope(scopes, reviewScopes[kind]),
  );
}

export async function lockPersonalKnowledgeCredential(
  db: Db,
  credential: PersonalKnowledgeCredential,
  scope: string,
) {
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

export function handlePersonalKnowledge(
  request: Request,
  scopeLabel: string,
  endpoint: string,
  work: (credential: PersonalKnowledgeCredential) => Promise<NextResponse>,
): Promise<NextResponse> {
  return handleOwnedExt(
    request,
    { scopeLabel, endpoint, method: request.method },
    async ({ actor }) => {
      if (
        actor.tokenKind !== "user" ||
        actor.projectId !== null ||
        actor.ownerUserId === null
      )
        throw new MaisterError(
          "UNAUTHORIZED",
          "This operation requires a global personal token",
        );

      return work({ tokenId: actor.tokenId, userId: actor.ownerUserId });
    },
    (error) => vaultErrorResponse(error, endpoint),
  );
}
