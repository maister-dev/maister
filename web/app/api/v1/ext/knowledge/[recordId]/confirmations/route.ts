import "server-only";

import { type NextRequest, type NextResponse } from "next/server";

import { getDb } from "@/lib/db/client";
import { MaisterError } from "@/lib/errors";
import { handleKnowledgeExt } from "@/lib/brain/knowledge-ext";
import { knowledgeJson, readKnowledgeJson } from "@/lib/brain/knowledge-http";
import { knowledgeConfirmationInputSchema } from "@/lib/brain/knowledge-write-types";
import { knowledgeRecordSelector } from "@/lib/brain/knowledge-url";
import { confirmKnowledgeRecord } from "@/lib/brain/knowledge-proposals";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ recordId: string }> },
): Promise<NextResponse> {
  return handleKnowledgeExt(
    request,
    "knowledge:confirm",
    "POST /api/v1/ext/knowledge/[recordId]/confirmations",
    async (principal) => {
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
    },
  );
}
