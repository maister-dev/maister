import "server-only";

import { type NextRequest, type NextResponse } from "next/server";

import { requireActiveSession } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import { companyBindingPageInputSchema } from "@/lib/agents/company-binding-types";
import { listCompanySpecialists } from "@/lib/agents/company-binding-list";
import {
  knowledgeErrorResponse,
  knowledgeJson,
} from "@/lib/brain/knowledge-http";
import { requireKnowledgeQueryKeys } from "@/lib/brain/knowledge-url";
import { MaisterError } from "@/lib/errors";

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const user = await requireActiveSession();
    const params = request.nextUrl.searchParams;

    requireKnowledgeQueryKeys(params, ["limit", "cursor"]);
    const limit = params.get("limit");
    const parsed = companyBindingPageInputSchema.safeParse({
      limit: limit === null ? undefined : Number(limit),
      cursor: params.get("cursor") ?? undefined,
    });

    if (!parsed.success || (limit !== null && !/^[1-9][0-9]*$/.test(limit)))
      throw new MaisterError(
        "CONFIG",
        "The company specialist page selector is invalid",
      );

    return knowledgeJson(
      await listCompanySpecialists(getDb(), user.id, parsed.data),
    );
  } catch (error) {
    return knowledgeErrorResponse(error, "GET /api/specialists");
  }
}
