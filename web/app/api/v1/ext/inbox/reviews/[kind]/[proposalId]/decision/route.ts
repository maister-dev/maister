import "server-only";

import { readVaultJson } from "@/lib/agent-memory-vault/http";
import { privateJson } from "@/lib/api/private-json";
import { getDb } from "@/lib/db/client";
import { MaisterError } from "@/lib/errors";
import { decideProposalReview } from "@/lib/queries/inbox-review-actions";
import {
  parseReviewSelector,
  parseSingleReviewDecision,
} from "@/lib/queries/knowledge-memory-reviews";
import { handlePersonalKnowledge } from "@/lib/tokens/personal-knowledge";

export async function POST(
  request: Request,
  route: { params: Promise<{ kind: string; proposalId: string }> },
) {
  return handlePersonalKnowledge(
    request,
    "decisions:review",
    "POST /api/v1/ext/inbox/reviews/{kind}/{proposalId}/decision",
    async (credential) => {
      const { kind, proposalId } = await route.params;
      const selector = parseReviewSelector({ kind, id: proposalId });

      if (selector.kind === "knowledge")
        throw new MaisterError(
          "CONFIG",
          "Use native knowledge decisions for this proposal",
        );

      return privateJson(
        await decideProposalReview(
          getDb(),
          credential.userId,
          parseSingleReviewDecision(selector, await readVaultJson(request)),
          credential,
        ),
      );
    },
  );
}
