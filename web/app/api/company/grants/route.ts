import "server-only";

import { type NextRequest, type NextResponse } from "next/server";

import { requireActiveSession } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import { createCompanyGrants, listCompanyGrants } from "@/lib/company/grants";
import {
  companyGrantInputSchema,
  companyGrantPageInputSchema,
} from "@/lib/company/grant-types";
import {
  privateErrorResponse,
  privateJson,
  readPrivateJson,
} from "@/lib/api/private-json";
import { requireKnowledgeQueryKeys } from "@/lib/brain/knowledge-url";
import { MaisterError } from "@/lib/errors";

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const user = await requireActiveSession();
    const params = request.nextUrl.searchParams;

    requireKnowledgeQueryKeys(params, ["limit", "cursor"]);
    const limit = params.get("limit");
    const parsed = companyGrantPageInputSchema.safeParse({
      limit: limit === null ? undefined : Number(limit),
      cursor: params.get("cursor") ?? undefined,
    });

    if (!parsed.success || (limit !== null && !/^[1-9][0-9]*$/.test(limit)))
      throw new MaisterError(
        "CONFIG",
        "Invalid company authority page selector",
      );

    return privateJson(await listCompanyGrants(getDb(), user.id, parsed.data));
  } catch (error) {
    return privateErrorResponse(error, "GET /api/company/grants");
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const user = await requireActiveSession();
    const parsed = companyGrantInputSchema.safeParse(
      await readPrivateJson(request),
    );

    if (!parsed.success)
      throw new MaisterError(
        "CONFIG",
        "Invalid explicit company authority input",
      );
    const result = await createCompanyGrants(getDb(), user.id, parsed.data);

    return privateJson(result.page, result.duplicate ? 200 : 201);
  } catch (error) {
    return privateErrorResponse(error, "POST /api/company/grants");
  }
}
