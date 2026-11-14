import "server-only";

import { type NextRequest, type NextResponse } from "next/server";

import { requireActiveSession } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import { revokeCompanyGrant } from "@/lib/company/grants";
import { companyGrantRevokeSchema } from "@/lib/company/grant-types";
import {
  privateErrorResponse,
  privateJson,
  readPrivateJson,
} from "@/lib/api/private-json";
import { MaisterError } from "@/lib/errors";

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ grantId: string }> },
): Promise<NextResponse> {
  try {
    const user = await requireActiveSession();
    const { grantId } = await params;
    const parsed = companyGrantRevokeSchema.safeParse(
      await readPrivateJson(request),
    );

    if (!parsed.success)
      throw new MaisterError(
        "CONFIG",
        "Invalid exact-revision company authority revocation",
      );

    return privateJson(
      await revokeCompanyGrant(getDb(), user.id, grantId, parsed.data),
    );
  } catch (error) {
    return privateErrorResponse(error, "DELETE /api/company/grants/[grantId]");
  }
}
