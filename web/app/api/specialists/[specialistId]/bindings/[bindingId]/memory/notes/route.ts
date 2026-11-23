import "server-only";

import type { InstallationVaultRoute } from "@/lib/agent-memory-vault/installation-route";

import { withInstallationVault } from "@/lib/agent-memory-vault/installation-route";
import { parseAgentMemoryView } from "@/lib/agent-memory-vault/commands";
import { viewAgentMemory, viewAgentNote } from "@/lib/agent-memory-vault/view";
import { privateJson } from "@/lib/api/private-json";
import { getDb } from "@/lib/db/client";
import { MaisterError } from "@/lib/errors";

export async function GET(request: Request, route: InstallationVaultRoute) {
  return withInstallationVault(route, "read", async (prepare) => {
    const query = new URL(request.url).searchParams;
    const noteId = query.get("noteId");

    if (noteId !== null) {
      const cursor = query.get("cursor") ?? undefined;

      if (
        noteId.length < 1 ||
        noteId.length > 192 ||
        noteId.includes("\0") ||
        query.getAll("noteId").length !== 1 ||
        query.getAll("cursor").length > 1 ||
        [...query.keys()].some(
          (name) => name !== "noteId" && name !== "cursor",
        ) ||
        (cursor !== undefined && cursor.length > 2048)
      )
        throw new MaisterError("CONFIG", "Invalid exact memory note selector");

      return privateJson(
        await viewAgentNote(getDb(), { noteId, cursor }, prepare),
      );
    }

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
