import "server-only";

import { NextResponse } from "next/server";

import { requireActiveSession } from "@/lib/authz";
import { previewLibrarianClear } from "@/lib/librarian/clear-history";
import { librarianErrorResponse } from "@/lib/librarian/http";

export async function GET(): Promise<NextResponse> {
  try {
    const owner = await requireActiveSession();

    return NextResponse.json(await previewLibrarianClear(owner.id));
  } catch (error) {
    return librarianErrorResponse(
      error,
      "GET /api/librarian/history/clear-preview",
    );
  }
}
