import "server-only";

import type { NextResponse } from "next/server";
import type { ProjectVaultRoute } from "@/lib/agent-memory-vault/project-route";

import { parseAgentMemoryView } from "@/lib/agent-memory-vault/commands";
import { withProjectVault } from "@/lib/agent-memory-vault/project-route";
import { viewAgentMemory, viewAgentNote } from "@/lib/agent-memory-vault/view";
import { privateJson } from "@/lib/api/private-json";
import { getDb } from "@/lib/db/client";
import { MaisterError } from "@/lib/errors";

export async function GET(
  request: Request,
  route: ProjectVaultRoute,
): Promise<NextResponse> {
  return withProjectVault(route, "readRepoFiles", async (prepare) => {
    const params = new URL(request.url).searchParams;
    const noteId = params.get("noteId");

    if (noteId !== null) {
      const cursor = params.get("cursor") ?? undefined;

      if (
        noteId.length < 1 ||
        noteId.length > 192 ||
        noteId.includes("\0") ||
        params.getAll("noteId").length !== 1 ||
        params.getAll("cursor").length > 1 ||
        [...params.keys()].some(
          (name) => name !== "noteId" && name !== "cursor",
        ) ||
        (cursor !== undefined && cursor.length > 2048)
      )
        throw new MaisterError("CONFIG", "Invalid exact memory note selector");

      return privateJson(
        await viewAgentNote(getDb(), { noteId, cursor }, prepare),
      );
    }

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
