import "server-only";

import { readPersonalVaultRevision } from "@/lib/agent-memory-vault/human-vault-read";
import { privateJson } from "@/lib/api/private-json";
import { getDb } from "@/lib/db/client";
import { handlePersonalKnowledge } from "@/lib/tokens/personal-knowledge";

export async function GET(
  request: Request,
  route: {
    params: Promise<{ locationId: string; noteId: string; revisionId: string }>;
  },
) {
  return handlePersonalKnowledge(
    request,
    "agent_memory:read",
    "GET /api/v1/ext/knowledge/vaults/{locationId}/notes/{noteId}/revisions/{revisionId}",
    async (credential) => {
      const { locationId, noteId, revisionId } = await route.params;

      return privateJson(
        await readPersonalVaultRevision(
          getDb(),
          credential,
          locationId,
          noteId,
          revisionId,
        ),
      );
    },
  );
}
