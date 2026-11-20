import "server-only";

import { type NextRequest, type NextResponse } from "next/server";

import { getDb } from "@/lib/db/client";
import { MaisterError } from "@/lib/errors";
import { handleKnowledgeExt } from "@/lib/brain/knowledge-ext";
import { knowledgeJson, readKnowledgeJson } from "@/lib/brain/knowledge-http";
import { knowledgeProposalInputSchema } from "@/lib/brain/knowledge-write-types";
import {
  submitKnowledgeProposal,
  knowledgeProposalHttpReceipt,
} from "@/lib/brain/knowledge-submit";
import { listKnowledgeProposals } from "@/lib/brain/knowledge-proposal-read";
import { knowledgeProposalsFromUrl } from "@/lib/brain/knowledge-url";

export async function GET(request: NextRequest): Promise<NextResponse> {
  return handleKnowledgeExt(
    request,
    "knowledge:review",
    "GET /api/v1/ext/knowledge/proposals",
    async (principal) =>
      knowledgeJson(
        await listKnowledgeProposals(
          getDb(),
          principal,
          knowledgeProposalsFromUrl(request.nextUrl.searchParams),
        ),
      ),
  );
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  return handleKnowledgeExt(
    request,
    "knowledge:propose",
    "POST /api/v1/ext/knowledge/proposals",
    async (principal) => {
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
    },
    { installation: true },
  );
}
