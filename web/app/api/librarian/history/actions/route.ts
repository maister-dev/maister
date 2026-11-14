import "server-only";

import { NextResponse, type NextRequest } from "next/server";

import { requireActiveSession } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import {
  parseActionHistoryQuery,
  readActionHistory,
} from "@/lib/librarian/action-history";
import { librarianErrorResponse } from "@/lib/librarian/http";

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const user = await requireActiveSession();
    const query = parseActionHistoryQuery(request.nextUrl.searchParams);

    return NextResponse.json(await readActionHistory(getDb(), user.id, query), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return librarianErrorResponse(error, "GET /api/librarian/history/actions");
  }
}
