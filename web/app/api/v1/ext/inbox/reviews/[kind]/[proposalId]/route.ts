import "server-only";

import { privateJson } from "@/lib/api/private-json";
import { getDb } from "@/lib/db/client";
import { MaisterError } from "@/lib/errors";
import { getProposalReviewDetail } from "@/lib/queries/inbox-review-actions";
import { parseReviewSelector } from "@/lib/queries/knowledge-memory-reviews";
import { handlePersonalKnowledge } from "@/lib/tokens/personal-knowledge";

export async function GET(
  request: Request,
  route: { params: Promise<{ kind: string; proposalId: string }> },
) {
  return handlePersonalKnowledge(
    request,
    "decisions:read",
    "GET /api/v1/ext/inbox/reviews/{kind}/{proposalId}",
    async (credential) => {
      const { kind, proposalId } = await route.params;
      const params = new URL(request.url).searchParams;
      const cursor = params.get("cursor");

      if (
        params.size > 1 ||
        (params.size !== 0 && (!cursor || cursor.length > 2048))
      )
        throw new MaisterError("CONFIG", "Invalid review continuation");

      return privateJson(
        await getProposalReviewDetail(
          getDb(),
          credential.userId,
          parseReviewSelector({ kind, id: proposalId }),
          cursor ?? undefined,
          credential,
        ),
      );
    },
  );
}
