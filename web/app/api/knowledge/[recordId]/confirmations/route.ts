import "server-only";

import { type NextRequest, type NextResponse } from "next/server";

import { getDb } from "@/lib/db/client";
import {
  knowledgeSessionPrincipal,
  knowledgeJson,
  knowledgeErrorResponse,
  readKnowledgeJson,
} from "@/lib/brain/knowledge-http";
import { knowledgeConfirmationInputSchema } from "@/lib/brain/knowledge-write-types";
import { confirmKnowledgeRecord } from "@/lib/brain/knowledge-proposals";
import { knowledgeRecordSelector } from "@/lib/brain/knowledge-url";
import { MaisterError } from "@/lib/errors";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ recordId: string }> },
): Promise<NextResponse> {
  try {
    const principal = await knowledgeSessionPrincipal();
    const { recordId } = await params;
    const selector = knowledgeRecordSelector(recordId, null);
    const parsed = knowledgeConfirmationInputSchema.safeParse(
      await readKnowledgeJson(request),
    );

    if (!parsed.success)
      throw new MaisterError(
        "CONFIG",
        "Invalid structured knowledge confirmation decision",
      );

    return knowledgeJson(
      await confirmKnowledgeRecord(getDb(), {
        principal,
        recordId: selector.recordId,
        ...parsed.data,
      }),
    );
  } catch (error) {
    return knowledgeErrorResponse(
      error,
      "POST /api/knowledge/[recordId]/confirmations",
    );
  }
}
