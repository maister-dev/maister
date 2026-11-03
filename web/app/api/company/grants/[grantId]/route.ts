import "server-only";

import { type NextRequest, type NextResponse } from "next/server";

import { requireActiveSession } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import { revokeCompanyGrant } from "@/lib/company/grants";
import { companyGrantRevokeSchema } from "@/lib/company/grant-types";
import {
  knowledgeJson,
  knowledgeErrorResponse,
  readKnowledgeJson,
} from "@/lib/brain/knowledge-http";
import { MaisterError } from "@/lib/errors";

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ grantId: string }> },
): Promise<NextResponse> {
  try {
    const user = await requireActiveSession();
    const { grantId } = await params;
    const parsed = companyGrantRevokeSchema.safeParse(
      await readKnowledgeJson(request),
    );

    if (!parsed.success)
      throw new MaisterError(
        "CONFIG",
        "Invalid exact-revision company authority revocation",
      );

    return knowledgeJson(
      await revokeCompanyGrant(getDb(), user.id, grantId, parsed.data),
    );
  } catch (error) {
    return knowledgeErrorResponse(
      error,
      "DELETE /api/company/grants/[grantId]",
    );
  }
}
