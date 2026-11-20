import "server-only";

import type { InstallationVaultRoute } from "@/lib/agent-memory-vault/installation-route";

import { withInstallationVault } from "@/lib/agent-memory-vault/installation-route";
import { parseAgentMemoryView } from "@/lib/agent-memory-vault/commands";
import { viewAgentMemory } from "@/lib/agent-memory-vault/view";
import { privateJson } from "@/lib/api/private-json";
import { getDb } from "@/lib/db/client";

export async function GET(request: Request, route: InstallationVaultRoute) {
  return withInstallationVault(route, "read", async (prepare) => {
    const query = new URL(request.url).searchParams;
    const limit = query.get("limit");
    const selection = parseAgentMemoryView({
      command: "view",
      path: query.get("path"),
      limit: limit === null ? undefined : Number(limit),
      cursor: query.get("cursor") ?? undefined,
    });

    return privateJson(await viewAgentMemory(getDb(), selection, prepare));
  });
}
