import "server-only";

import {
  listHumanVaultLocations,
  parseHumanVaultSelection,
} from "@/lib/agent-memory-vault/human-catalog";
import { privateJson } from "@/lib/api/private-json";
import { getDb } from "@/lib/db/client";
import { handlePersonalKnowledge } from "@/lib/tokens/personal-knowledge";

export async function GET(request: Request) {
  return handlePersonalKnowledge(
    request,
    "agent_memory:read",
    "GET /api/v1/ext/knowledge/vaults",
    async (credential) =>
      privateJson(
        await listHumanVaultLocations(
          getDb(),
          credential.userId,
          parseHumanVaultSelection(new URL(request.url).searchParams),
          credential,
        ),
      ),
  );
}
