import "server-only";

import { type NextRequest, type NextResponse } from "next/server";

import { getDb } from "@/lib/db/client";
import { MaisterError } from "@/lib/errors";
import { knowledgeJson, readKnowledgeJson } from "@/lib/brain/knowledge-http";
import { handleKnowledgeExt } from "@/lib/brain/knowledge-ext";
import { captureKnowledgeSource } from "@/lib/brain/knowledge-source-capture";
import { knowledgeSourceCaptureSchema } from "@/lib/brain/knowledge-read-types";

export async function POST(request: NextRequest): Promise<NextResponse> {
  return handleKnowledgeExt(
    request,
    "knowledge:propose",
    "POST /api/v1/ext/knowledge/sources",
    async (principal) => {
      const parsed = knowledgeSourceCaptureSchema.safeParse(
        await readKnowledgeJson(request),
      );

      if (!parsed.success)
        throw new MaisterError("CONFIG", "Invalid bounded source capture");
      const result = await captureKnowledgeSource(
        getDb(),
        principal,
        parsed.data,
      );

      return knowledgeJson(result.witness, result.duplicate ? 200 : 201);
    },
  );
}
