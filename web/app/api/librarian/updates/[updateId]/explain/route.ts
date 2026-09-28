import "server-only";

import { NextResponse } from "next/server";

import { requireActiveSession } from "@/lib/authz";
import { explainLibrarianUpdate } from "@/lib/librarian/explain";
import { librarianErrorResponse } from "@/lib/librarian/http";

export async function POST(
  _request: Request,
  context: { params: Promise<{ updateId: string }> },
): Promise<NextResponse> {
  try {
    const owner = await requireActiveSession();
    const { updateId } = await context.params;
    const turn = await explainLibrarianUpdate(owner.id, updateId);

    return NextResponse.json({ turn }, { status: 202 });
  } catch (error) {
    return librarianErrorResponse(
      error,
      "POST /api/librarian/updates/[updateId]/explain",
    );
  }
}
