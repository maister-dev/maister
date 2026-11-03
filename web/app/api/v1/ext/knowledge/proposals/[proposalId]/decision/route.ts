import "server-only";

import { type NextRequest, type NextResponse } from "next/server";

import { getDb } from "@/lib/db/client";
import { MaisterError } from "@/lib/errors";
import { postgresTextSchema } from "@/lib/text-schema";
import { handleKnowledgeExt } from "@/lib/brain/knowledge-ext";
import { knowledgeJson, readKnowledgeJson } from "@/lib/brain/knowledge-http";
import { knowledgeProposalDecisionSchema } from "@/lib/brain/knowledge-write-types";
import { knowledgeProposalHttpReceipt } from "@/lib/brain/knowledge-submit";
import { reviewKnowledgeProposal } from "@/lib/brain/knowledge-proposals";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ proposalId: string }> },
): Promise<NextResponse> {
  return handleKnowledgeExt(
    request,
    "knowledge:review",
    "POST /api/v1/ext/knowledge/proposals/[proposalId]/decision",
    async (principal) => {
      const { proposalId } = await params;
      const parsed = knowledgeProposalDecisionSchema.safeParse(
        await readKnowledgeJson(request),
      );

      if (
        !parsed.success ||
        !postgresTextSchema.min(1).max(128).safeParse(proposalId).success
      )
        throw new MaisterError(
          "CONFIG",
          "Invalid structured knowledge proposal decision",
        );

      return knowledgeJson(
        knowledgeProposalHttpReceipt(
          await reviewKnowledgeProposal(getDb(), {
            principal,
            proposalId,
            ...parsed.data,
          }),
        ),
      );
    },
  );
}
