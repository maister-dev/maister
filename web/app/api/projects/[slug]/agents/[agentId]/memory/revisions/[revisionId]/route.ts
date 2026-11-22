import "server-only";

import type { NextResponse } from "next/server";

import { vaultRevisionDetail } from "@/lib/agent-memory-vault/history";
import { withProjectVault } from "@/lib/agent-memory-vault/project-route";
import { privateJson } from "@/lib/api/private-json";
import { getDb } from "@/lib/db/client";
import { decodeRouteParam } from "@/lib/route-params";

export async function GET(
  request: Request,
  route: {
    params: Promise<{ slug: string; agentId: string; revisionId: string }>;
  },
): Promise<NextResponse> {
  return withProjectVault(route, "readRepoFiles", async (prepare) =>
    privateJson(
      await vaultRevisionDetail(
        getDb(),
        decodeRouteParam((await route.params).revisionId, "revisionId"),
        prepare,
        new URL(request.url).searchParams.get("noteId") ?? undefined,
      ),
    ),
  );
}
