import "server-only";

import {
  readVaultJson,
  vaultErrorResponse,
} from "@/lib/agent-memory-vault/http";
import { privateJson } from "@/lib/api/private-json";
import { requireActiveSession } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import { decideProposalReviewBatch } from "@/lib/queries/inbox-review-actions";
import { parseReviewBatch } from "@/lib/queries/knowledge-memory-reviews";

export async function POST(request: Request) {
  try {
    const user = await requireActiveSession();
    const { items } = parseReviewBatch(await readVaultJson(request));

    return privateJson(
      await decideProposalReviewBatch(getDb(), user.id, items),
    );
  } catch (error) {
    return vaultErrorResponse(error, "decide Inbox proposal reviews");
  }
}
