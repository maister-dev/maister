import "server-only";

import { type NextRequest, type NextResponse } from "next/server";

import { requireActiveSession } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import {
  companyBindingDetachSchema,
  companyBindingUpdateSchema,
} from "@/lib/agents/company-binding-types";
import { getCompanySpecialistBinding } from "@/lib/agents/company-bindings";
import {
  detachCompanySpecialistBinding,
  updateCompanySpecialistBinding,
} from "@/lib/agents/company-binding-mutations";
import {
  knowledgeErrorResponse,
  knowledgeJson,
  readKnowledgeJson,
} from "@/lib/brain/knowledge-http";
import { requireKnowledgeQueryKeys } from "@/lib/brain/knowledge-url";
import { MaisterError } from "@/lib/errors";

type Context = Readonly<{
  params: Promise<{ specialistId: string; bindingId: string }>;
}>;

export async function GET(
  request: NextRequest,
  context: Context,
): Promise<NextResponse> {
  try {
    const user = await requireActiveSession();
    const { specialistId, bindingId } = await context.params;

    requireKnowledgeQueryKeys(request.nextUrl.searchParams, []);

    return knowledgeJson(
      await getCompanySpecialistBinding(
        getDb(),
        user.id,
        specialistId,
        bindingId,
      ),
    );
  } catch (error) {
    return knowledgeErrorResponse(
      error,
      "GET /api/specialists/:specialistId/bindings/:bindingId",
    );
  }
}

export async function PATCH(
  request: NextRequest,
  context: Context,
): Promise<NextResponse> {
  try {
    const user = await requireActiveSession();
    const { specialistId, bindingId } = await context.params;
    const parsed = companyBindingUpdateSchema.safeParse(
      await readKnowledgeJson(request),
    );

    if (!parsed.success)
      throw new MaisterError(
        "CONFIG",
        "The company specialist replacement request is invalid",
      );
    const result = await updateCompanySpecialistBinding(
      getDb(),
      user.id,
      specialistId,
      bindingId,
      parsed.data,
    );

    return knowledgeJson(result.specialist);
  } catch (error) {
    return knowledgeErrorResponse(
      error,
      "PATCH /api/specialists/:specialistId/bindings/:bindingId",
    );
  }
}

export async function DELETE(
  request: NextRequest,
  context: Context,
): Promise<NextResponse> {
  try {
    const user = await requireActiveSession();
    const { specialistId, bindingId } = await context.params;
    const parsed = companyBindingDetachSchema.safeParse(
      await readKnowledgeJson(request),
    );

    if (!parsed.success)
      throw new MaisterError(
        "CONFIG",
        "The company specialist detach request is invalid",
      );

    return knowledgeJson(
      await detachCompanySpecialistBinding(
        getDb(),
        user.id,
        specialistId,
        bindingId,
        parsed.data,
      ),
    );
  } catch (error) {
    return knowledgeErrorResponse(
      error,
      "DELETE /api/specialists/:specialistId/bindings/:bindingId",
    );
  }
}
