import "server-only";

import {
  readVaultJson,
  vaultErrorResponse,
} from "@/lib/agent-memory-vault/http";
import { privateJson } from "@/lib/api/private-json";
import { requireActiveSession } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import { decideProposalReview } from "@/lib/queries/inbox-review-actions";
import {
  parseReviewSelector,
  parseSingleReviewDecision,
} from "@/lib/queries/knowledge-memory-reviews";

export async function POST(
  request: Request,
  route: { params: Promise<{ kind: string; proposalId: string }> },
) {
  try {
    const user = await requireActiveSession();
    const { kind, proposalId } = await route.params;
    const selector = parseReviewSelector({ kind, id: proposalId });
    const input = parseSingleReviewDecision(
      selector,
      await readVaultJson(request),
    );

    return privateJson(await decideProposalReview(getDb(), user.id, input));
  } catch (error) {
    return vaultErrorResponse(error, "settle Inbox proposal decision");
  }
}
