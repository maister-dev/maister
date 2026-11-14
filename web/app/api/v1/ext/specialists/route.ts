import "server-only";

import type { NextRequest, NextResponse } from "next/server";

import { listCompanySpecialists } from "@/lib/agents/company-binding-list";
import { companyBindingPageInputSchema } from "@/lib/agents/company-binding-types";
import { privateJson } from "@/lib/api/private-json";
import { getDb } from "@/lib/db/client";
import { MaisterError } from "@/lib/errors";
import { handlePersonalAssignmentExt } from "@/lib/specialist-assignments/external";
import { assignmentPageQuery } from "@/lib/specialist-assignments/http";

export async function GET(request: NextRequest): Promise<NextResponse> {
  return handlePersonalAssignmentExt(
    request,
    "specialists:read",
    "GET /api/v1/ext/specialists",
    async (userId) => {
      const query = assignmentPageQuery(request);
      const parsed = companyBindingPageInputSchema.safeParse({
        cursor: query.cursor,
        limit: query.limit === undefined ? undefined : Number(query.limit),
      });

      if (!parsed.success)
        throw new MaisterError(
          "CONFIG",
          "The company specialist page selector is invalid",
        );

      return privateJson(
        await listCompanySpecialists(getDb(), userId, parsed.data),
      );
    },
  );
}
