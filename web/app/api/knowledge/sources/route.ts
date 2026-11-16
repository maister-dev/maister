import "server-only";

import { type NextRequest, type NextResponse } from "next/server";

import { getDb } from "@/lib/db/client";
import { MaisterError } from "@/lib/errors";
import { captureKnowledgeSource } from "@/lib/brain/knowledge-source-capture";
import { knowledgeSourceCaptureSchema } from "@/lib/brain/knowledge-read-types";
import {
  knowledgeSessionPrincipal,
  knowledgeJson,
  knowledgeErrorResponse,
  readKnowledgeJson,
} from "@/lib/brain/knowledge-http";

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const principal = await knowledgeSessionPrincipal();
    const body = knowledgeSourceCaptureSchema.safeParse(
      await readKnowledgeJson(request),
    );

    if (!body.success)
      throw new MaisterError(
        "CONFIG",
        "Source capture body does not match the native contract",
      );
    const result = await captureKnowledgeSource(getDb(), principal, body.data);

    return knowledgeJson(result.witness, result.duplicate ? 200 : 201);
  } catch (error) {
    return knowledgeErrorResponse(error, "POST /api/knowledge/sources");
  }
}
