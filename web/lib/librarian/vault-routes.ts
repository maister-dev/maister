import "server-only";

import { z } from "zod";

import { listLibrarianVaults, prepareLibrarianVault } from "./vaults";

import { parseAgentMemoryView } from "@/lib/agent-memory-vault/commands";
import { vaultErrorResponse } from "@/lib/agent-memory-vault/http";
import { memoryIndexReaders } from "@/lib/agent-memory-vault/index-route";
import { viewAgentMemory } from "@/lib/agent-memory-vault/view";
import { privateJson } from "@/lib/api/private-json";
import { getDb } from "@/lib/db/client";
import { MaisterError } from "@/lib/errors";
import { handleOwnedExt } from "@/lib/tokens/owned-ext-handler";

const paging = {
  limit: z
    .string()
    .regex(/^[1-9][0-9]{0,2}$/)
    .transform(Number)
    .pipe(z.number().max(100))
    .prefault("20"),
  cursor: z.string().min(1).max(2048).optional(),
};

function query<T>(request: Request, schema: z.ZodType<T>) {
  const params = new URL(request.url).searchParams;
  const entries = Object.fromEntries(params);
  const selection = schema.safeParse(entries);
  if (!selection.success || Object.keys(entries).length !== params.size)
    throw new MaisterError("CONFIG", "Invalid librarian vault selection");

  return selection.data;
}

export function librarianVaultList(request: Request) {
  const endpoint = "GET /api/v1/ext/librarian/vaults";

  return handleOwnedExt(
    request,
    {
      endpoint,
      method: "GET",
      scopeLabel: "agent_memory:read",
      admitLibrarian: true,
    },
    async ({ actor }) => {
      const { limit, cursor } = query(request, z.strictObject(paging));

      return privateJson(
        await listLibrarianVaults(getDb(), actor.tokenId, limit, cursor),
      );
    },
    (error) => vaultErrorResponse(error, endpoint),
  );
}

export function librarianVaultReader(
  resource: "view" | keyof typeof memoryIndexReaders,
) {
  const endpoint = `GET /api/v1/ext/librarian/vaults/[vaultId]/${resource}`;

  return (request: Request, route: { params: Promise<{ vaultId: string }> }) =>
    handleOwnedExt(
      request,
      {
        endpoint,
        method: "GET",
        scopeLabel: "agent_memory:read",
        admitLibrarian: true,
      },
      async ({ actor }) => {
        const { vaultId } = await route.params;
        const prepare = prepareLibrarianVault(actor.tokenId, vaultId);
        if (resource !== "view")
          return privateJson(
            await memoryIndexReaders[resource](request, prepare),
          );
        const selection = query(
          request,
          z.strictObject({ ...paging, path: z.string().min(1).max(512) }),
        );

        return privateJson(
          await viewAgentMemory(
            getDb(),
            parseAgentMemoryView({ command: "view", ...selection }),
            prepare,
          ),
        );
      },
      (error) => vaultErrorResponse(error, endpoint),
    );
}
