import "server-only";

import type { NextResponse } from "next/server";
import type { ProjectVaultRoute } from "@/lib/agent-memory-vault/project-route";

import { parseAgentMemoryView } from "@/lib/agent-memory-vault/commands";
import { withProjectVault } from "@/lib/agent-memory-vault/project-route";
import { viewAgentMemory } from "@/lib/agent-memory-vault/view";
import { privateJson } from "@/lib/api/private-json";
import { getDb } from "@/lib/db/client";

export async function GET(
  request: Request,
  route: ProjectVaultRoute,
): Promise<NextResponse> {
  return withProjectVault(route, "readRepoFiles", async (prepare) => {
    const params = new URL(request.url).searchParams;
    const rawLimit = params.get("limit");
    const command = parseAgentMemoryView({
      command: "view",
      path: params.get("path"),
      cursor: params.get("cursor") ?? undefined,
      limit: rawLimit === null ? undefined : Number(rawLimit),
    });

    return privateJson(await viewAgentMemory(getDb(), command, prepare));
  });
}
