import "server-only";

import { type NextRequest, type NextResponse } from "next/server";

import { getDb } from "@/lib/db/client";
import {
  knowledgeSessionPrincipal,
  knowledgeJson,
  knowledgeErrorResponse,
  readKnowledgeJson,
} from "@/lib/brain/knowledge-http";
import { knowledgeProposalInputSchema } from "@/lib/brain/knowledge-write-types";
import {
  submitKnowledgeProposal,
  knowledgeProposalHttpReceipt,
} from "@/lib/brain/knowledge-submit";
import { MaisterError } from "@/lib/errors";
import { listKnowledgeProposals } from "@/lib/brain/knowledge-proposal-read";
import { knowledgeProposalsFromUrl } from "@/lib/brain/knowledge-url";

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const principal = await knowledgeSessionPrincipal();

    return knowledgeJson(
      await listKnowledgeProposals(
        getDb(),
        principal,
        knowledgeProposalsFromUrl(request.nextUrl.searchParams),
      ),
    );
  } catch (error) {
    return knowledgeErrorResponse(error, "GET /api/knowledge/proposals");
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const principal = await knowledgeSessionPrincipal();
    const parsed = knowledgeProposalInputSchema.safeParse(
      await readKnowledgeJson(request),
    );

    if (!parsed.success)
      throw new MaisterError(
        "CONFIG",
        "Invalid structured knowledge proposal input",
      );
    const receipt = await submitKnowledgeProposal(
      getDb(),
      principal,
      parsed.data,
    );

    return knowledgeJson(
      knowledgeProposalHttpReceipt(receipt),
      receipt.duplicate ? 200 : 201,
    );
  } catch (error) {
    return knowledgeErrorResponse(error, "POST /api/knowledge/proposals");
  }
}
