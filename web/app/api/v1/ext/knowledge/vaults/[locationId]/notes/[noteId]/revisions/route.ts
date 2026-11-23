import "server-only";

import {
  listPersonalVaultRevisions,
  parseVaultReadQuery,
} from "@/lib/agent-memory-vault/human-vault-read";
import { privateJson } from "@/lib/api/private-json";
import { getDb } from "@/lib/db/client";
import { handlePersonalKnowledge } from "@/lib/tokens/personal-knowledge";

export async function GET(
  request: Request,
  route: { params: Promise<{ locationId: string; noteId: string }> },
) {
  return handlePersonalKnowledge(
    request,
    "agent_memory:read",
    "GET /api/v1/ext/knowledge/vaults/{locationId}/notes/{noteId}/revisions",
    async (credential) => {
      const { locationId, noteId } = await route.params;
      const query = parseVaultReadQuery(request, ["limit", "cursor"]);

      return privateJson(
        await listPersonalVaultRevisions(
          getDb(),
          credential,
          locationId,
          noteId,
          query,
        ),
      );
    },
  );
}
