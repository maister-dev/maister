import "server-only";

import {
  readPersonalVaultPath,
  parseVaultReadQuery,
} from "@/lib/agent-memory-vault/human-vault-read";
import { privateJson } from "@/lib/api/private-json";
import { getDb } from "@/lib/db/client";
import { handlePersonalKnowledge } from "@/lib/tokens/personal-knowledge";

export async function GET(
  request: Request,
  route: { params: Promise<{ locationId: string }> },
) {
  return handlePersonalKnowledge(
    request,
    "agent_memory:read",
    "GET /api/v1/ext/knowledge/vaults/{locationId}/view",
    async (credential) => {
      const { locationId } = await route.params;
      const query = parseVaultReadQuery(request, ["path", "limit", "cursor"]);

      return privateJson(
        await readPersonalVaultPath(getDb(), credential, locationId, query),
      );
    },
  );
}
