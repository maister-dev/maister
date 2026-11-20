import "server-only";

import type { InstallationVaultRoute } from "@/lib/agent-memory-vault/installation-route";

import { withInstallationVault } from "@/lib/agent-memory-vault/installation-route";
import {
  parseVaultHistory,
  vaultHistory,
} from "@/lib/agent-memory-vault/history";
import { privateJson } from "@/lib/api/private-json";
import { getDb } from "@/lib/db/client";

export async function GET(request: Request, route: InstallationVaultRoute) {
  return withInstallationVault(route, "read", async (prepare) => {
    const query = new URL(request.url).searchParams;
    const limit = query.get("limit");
    const selection = parseVaultHistory({
      noteId: query.get("noteId"),
      cursor: query.get("cursor") ?? undefined,
      limit: limit === null ? undefined : Number(limit),
    });

    return privateJson(await vaultHistory(getDb(), selection, prepare));
  });
}
