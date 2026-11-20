import "server-only";

import { NextRequest, NextResponse } from "next/server";

import { privateErrorResponse, privateJson } from "@/lib/api/private-json";
import { getDb } from "@/lib/db/client";
import { isMaisterError } from "@/lib/errors";
import { searchLibrarianHistoryForTurn } from "@/lib/librarian/history-search";
import { handleExt } from "@/lib/tokens/ext-handler";

const ENDPOINT = "GET /api/v1/ext/librarian/history/search";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const db = getDb();

  return handleExt(
    request,
    {
      scopeLabel: "librarian:history",
      endpoint: ENDPOINT,
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

      try {
        return privateJson(
          await searchLibrarianHistoryForTurn(context.actor.tokenId, q, db),
        );
      } catch (error) {
        if (isMaisterError(error) && error.code === "CONFIG")
          return privateJson({ code: error.code, message: error.message }, 422);

        return privateErrorResponse(error, ENDPOINT);
      }
    },
  );
}
