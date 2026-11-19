import "server-only";

import { vaultErrorResponse } from "@/lib/agent-memory-vault/http";
import { privateJson } from "@/lib/api/private-json";
import { requireActiveSession } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import { getProposalReviewDetail } from "@/lib/queries/inbox-review-actions";
import { parseReviewSelector } from "@/lib/queries/knowledge-memory-reviews";

export async function GET(
  _request: Request,
  route: { params: Promise<{ kind: string; proposalId: string }> },
) {
  try {
    const user = await requireActiveSession();
    const { kind, proposalId } = await route.params;

    return privateJson(
      await getProposalReviewDetail(
        getDb(),
        user.id,
        parseReviewSelector({ kind, id: proposalId }),
      ),
    );
  } catch (error) {
    return vaultErrorResponse(error, "read Inbox proposal review");
  }
}
