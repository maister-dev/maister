import "server-only";

import { type NextRequest, type NextResponse } from "next/server";

import { requireActiveSession } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import { companyBindingCreateSchema } from "@/lib/agents/company-binding-types";
import { createCompanySpecialistBinding } from "@/lib/agents/company-bindings";
import {
  knowledgeErrorResponse,
  knowledgeJson,
  readKnowledgeJson,
} from "@/lib/brain/knowledge-http";
import { MaisterError } from "@/lib/errors";

type Context = Readonly<{ params: Promise<{ specialistId: string }> }>;

export async function POST(
  request: NextRequest,
  context: Context,
): Promise<NextResponse> {
  try {
    const user = await requireActiveSession();
    const { specialistId } = await context.params;
    const parsed = companyBindingCreateSchema.safeParse(
      await readKnowledgeJson(request),
    );

    if (!parsed.success)
      throw new MaisterError(
        "CONFIG",
        "The company specialist binding request is invalid",
      );
    const result = await createCompanySpecialistBinding(
      getDb(),
      user.id,
      specialistId,
      parsed.data,
    );

    return knowledgeJson(result.specialist, result.duplicate ? 200 : 201);
  } catch (error) {
    return knowledgeErrorResponse(
      error,
      "POST /api/specialists/:specialistId/bindings",
    );
  }
}
