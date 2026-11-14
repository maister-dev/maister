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
  privateErrorResponse,
  privateJson,
  readPrivateJson,
} from "@/lib/api/private-json";
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

    return privateJson(
      await getCompanySpecialistBinding(
        getDb(),
        user.id,
        specialistId,
        bindingId,
      ),
    );
  } catch (error) {
    return privateErrorResponse(
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
      await readPrivateJson(request),
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

    return privateJson(result.specialist);
  } catch (error) {
    return privateErrorResponse(
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
      await readPrivateJson(request),
    );

    if (!parsed.success)
      throw new MaisterError(
        "CONFIG",
        "The company specialist detach request is invalid",
      );

    return privateJson(
      await detachCompanySpecialistBinding(
        getDb(),
        user.id,
        specialistId,
        bindingId,
        parsed.data,
      ),
    );
  } catch (error) {
    return privateErrorResponse(
      error,
      "DELETE /api/specialists/:specialistId/bindings/:bindingId",
    );
  }
}
