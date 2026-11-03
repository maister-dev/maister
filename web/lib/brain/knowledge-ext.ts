import "server-only";

import type { NextResponse } from "next/server";
import type { KnowledgeAction, KnowledgePrincipal } from "./knowledge-types";

import { knowledgeErrorResponse } from "./knowledge-http";

import { handleOwnedExt } from "@/lib/tokens/owned-ext-handler";

export async function handleKnowledgeExt(
  request: Request,
  scopeLabel: KnowledgeAction,
  endpoint: string,
  work: (principal: KnowledgePrincipal) => Promise<NextResponse>,
): Promise<NextResponse> {
  return handleOwnedExt(
    request,
    { scopeLabel, endpoint, method: request.method },
    async ({ actor }) => work({ kind: "token", tokenId: actor.tokenId }),
    (error) => knowledgeErrorResponse(error, endpoint),
  );
}
