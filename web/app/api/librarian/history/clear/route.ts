import "server-only";

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireActiveSession } from "@/lib/authz";
import { clearLibrarianHistory } from "@/lib/librarian/clear-history";
import { invalidBody, librarianErrorResponse } from "@/lib/librarian/http";

const schema = z
  .object({ previewDigest: z.string().regex(/^[0-9a-f]{64}$/) })
  .strict();

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const owner = await requireActiveSession();
    const parsed = schema.safeParse(await request.json().catch(() => null));

    if (!parsed.success) return invalidBody("valid previewDigest required");

    return NextResponse.json({
      resetState: await clearLibrarianHistory(
        owner.id,
        parsed.data.previewDigest,
      ),
    });
  } catch (error) {
    return librarianErrorResponse(error, "POST /api/librarian/history/clear");
  }
}
