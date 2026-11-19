import "server-only";

import { vaultErrorResponse } from "@/lib/agent-memory-vault/http";
import { privateJson } from "@/lib/api/private-json";
import { requireActiveSession } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import { MaisterError } from "@/lib/errors";
import {
  listProposalReviews,
  parseReviewFilters,
} from "@/lib/queries/knowledge-memory-reviews";

export async function GET(request: Request) {
  try {
    const user = await requireActiveSession();
    const params = new URL(request.url).searchParams;
    const raw = Object.fromEntries(params);
    if (params.size !== Object.keys(raw).length)
      throw new MaisterError("CONFIG", "Repeated Inbox review filter");

    return privateJson(
      await listProposalReviews(getDb(), user.id, parseReviewFilters(raw)),
    );
  } catch (error) {
    return vaultErrorResponse(error, "list Inbox proposal reviews");
  }
}
