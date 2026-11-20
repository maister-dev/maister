import "server-only";

import type { KnowledgeAction, KnowledgePrincipal } from "./knowledge-types";

import { NextResponse } from "next/server";

import { knowledgeErrorResponse } from "./knowledge-http";

import { handleOwnedExt } from "@/lib/tokens/owned-ext-handler";

export async function handleKnowledgeExt(
  request: Request,
  scopeLabel: KnowledgeAction,
  endpoint: string,
  work: (principal: KnowledgePrincipal) => Promise<NextResponse>,
  admission?: Readonly<{ installation?: true; librarian?: "read" | "confirm" }>,
): Promise<NextResponse> {
  return handleOwnedExt(
    request,
    {
      scopeLabel,
      endpoint,
      method: request.method,
      admitInstallation: admission?.installation,
      admitLibrarian: admission?.librarian === "read" ? true : undefined,
    },
    async ({ actor }) =>
      work({
        kind: actor.tokenKind === "librarian" ? "librarian_read" : "token",
        tokenId: actor.tokenId,
      }),
    (error) => {
      const response = knowledgeErrorResponse(error, endpoint);

      // The external API uses 422 for CONFIG/JSON validation; session routes retain 400.
      return response.status === 400
        ? new NextResponse(response.body, {
            status: 422,
            headers: response.headers,
          })
        : response;
    },
  );
}
