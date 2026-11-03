import "server-only";

import { type NextRequest, type NextResponse } from "next/server";

import { getDb } from "@/lib/db/client";
import {
  knowledgeSessionPrincipal,
  knowledgeJson,
  knowledgeErrorResponse,
  readKnowledgeJson,
} from "@/lib/brain/knowledge-http";
import { knowledgeProposalDecisionSchema } from "@/lib/brain/knowledge-write-types";
import { knowledgeProposalHttpReceipt } from "@/lib/brain/knowledge-submit";
import { reviewKnowledgeProposal } from "@/lib/brain/knowledge-proposals";
import { MaisterError } from "@/lib/errors";
import { postgresTextSchema } from "@/lib/text-schema";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ proposalId: string }> },
): Promise<NextResponse> {
  try {
    const principal = await knowledgeSessionPrincipal();
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
    const receipt = await reviewKnowledgeProposal(getDb(), {
      principal,
      proposalId,
      ...parsed.data,
    });

    return knowledgeJson(knowledgeProposalHttpReceipt(receipt));
  } catch (error) {
    return knowledgeErrorResponse(
      error,
      "POST /api/knowledge/proposals/[proposalId]/decision",
    );
  }
}
