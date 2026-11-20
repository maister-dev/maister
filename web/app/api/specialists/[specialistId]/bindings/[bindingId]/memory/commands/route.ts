import "server-only";

import type { InstallationVaultRoute } from "@/lib/agent-memory-vault/installation-route";

import { withInstallationVault } from "@/lib/agent-memory-vault/installation-route";
import { parseAgentMemoryMutation } from "@/lib/agent-memory-vault/commands";
import {
  vaultMutationResponse,
  readVaultJson,
} from "@/lib/agent-memory-vault/http";
import { agentMemoryVaultLimits } from "@/lib/agent-memory-vault/limits";
import { applyVaultMutation } from "@/lib/agent-memory-vault/store";
import { getDb } from "@/lib/db/client";

export async function POST(request: Request, route: InstallationVaultRoute) {
  return withInstallationVault(route, "edit", async (prepare) =>
    vaultMutationResponse(
      await applyVaultMutation(
        getDb(),
        parseAgentMemoryMutation(await readVaultJson(request)),
        prepare,
        agentMemoryVaultLimits(),
      ),
    ),
  );
}
