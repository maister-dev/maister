import "server-only";

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireActiveSession } from "@/lib/authz";
import { decideLibrarianCard } from "@/lib/librarian/card-decisions";
import { invalidBody, librarianErrorResponse } from "@/lib/librarian/http";

const bodySchema = z
  .object({
    decision: z.enum(["accept", "reject"]),
    expectedRevision: z.number().int().nonnegative().optional(),
  })
  .strict();

type RouteParams = { params: Promise<{ cardId: string }> };

export async function POST(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { cardId } = await params;

  try {
    const user = await requireActiveSession();
    const parsed = bodySchema.safeParse(await req.json().catch(() => null));

    if (!parsed.success)
      return invalidBody(
        parsed.error.issues[0]?.message ?? "invalid card decision",
      );

    const result = await decideLibrarianCard({ cardId, user, ...parsed.data });

    return NextResponse.json(result.body, { status: result.statusCode });
  } catch (err) {
    return librarianErrorResponse(
      err,
      "POST /api/librarian/cards/[cardId]/decide",
    );
  }
}
