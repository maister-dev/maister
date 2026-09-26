import "server-only";

import { NextRequest, NextResponse } from "next/server";

import { getDb } from "@/lib/db/client";
import { searchLibrarianHistory } from "@/lib/librarian/history-search";
import { handleExt } from "@/lib/tokens/ext-handler";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const db = getDb();

  return handleExt(
    request,
    {
      scopeLabel: "librarian:history",
      endpoint: "GET /api/v1/ext/librarian/history/search",
      method: "GET",
      admitLibrarian: true,
      allowGlobalActorWithoutProject: true,
      db,
    },
    async (context) => {
      if (context.actor.tokenKind !== "librarian" || !context.actor.ownerUserId)
        return NextResponse.json(
          { code: "UNAUTHORIZED", message: "librarian token required" },
          { status: 403 },
        );
      const q = request.nextUrl.searchParams.get("q") ?? "";

      return NextResponse.json(
        await searchLibrarianHistory(context.actor.ownerUserId, q, db),
      );
    },
  );
}
