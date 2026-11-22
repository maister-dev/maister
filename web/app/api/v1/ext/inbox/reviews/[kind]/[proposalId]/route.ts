import "server-only";

import { privateJson } from "@/lib/api/private-json";
import { getDb } from "@/lib/db/client";
import {
  getProposalReviewDetail,
  parseReviewContinuations,
} from "@/lib/queries/inbox-review-actions";
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

      return privateJson(
        await getProposalReviewDetail(
          getDb(),
          credential.userId,
          parseReviewSelector({ kind, id: proposalId }),
          { ...parseReviewContinuations(request), credential },
        ),
      );
    },
  );
}
