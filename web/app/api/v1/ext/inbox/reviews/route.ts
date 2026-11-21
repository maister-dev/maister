import "server-only";

import { privateJson } from "@/lib/api/private-json";
import { getDb } from "@/lib/db/client";
import { MaisterError } from "@/lib/errors";
import {
  listProposalReviews,
  parseReviewFilters,
} from "@/lib/queries/knowledge-memory-reviews";
import { handlePersonalKnowledge } from "@/lib/tokens/personal-knowledge";

export async function GET(request: Request) {
  return handlePersonalKnowledge(
    request,
    "decisions:read",
    "GET /api/v1/ext/inbox/reviews",
    async (credential) => {
      const params = new URL(request.url).searchParams;

      if (params.size !== new Set(params.keys()).size)
        throw new MaisterError("CONFIG", "Repeated review selector");

      return privateJson(
        await listProposalReviews(
          getDb(),
          credential.userId,
          parseReviewFilters(Object.fromEntries(params)),
          credential,
        ),
      );
    },
  );
}
