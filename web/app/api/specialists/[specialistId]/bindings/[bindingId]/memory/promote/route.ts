import "server-only";

import type { InstallationVaultRoute } from "@/lib/agent-memory-vault/installation-route";

import {
  readVaultJson,
  vaultMutationResponse,
} from "@/lib/agent-memory-vault/http";
import { withInstallationVault } from "@/lib/agent-memory-vault/installation-route";
import {
  parseMemoryPromotion,
  promoteMemory,
} from "@/lib/agent-memory-vault/promotion";
import { getDb } from "@/lib/db/client";

export async function POST(request: Request, route: InstallationVaultRoute) {
  return withInstallationVault(route, "edit", async (prepare, userId) => {
    const input = parseMemoryPromotion(await readVaultJson(request));

    return vaultMutationResponse(
      await promoteMemory(getDb(), { kind: "user", userId }, input, prepare),
    );
  });
}
