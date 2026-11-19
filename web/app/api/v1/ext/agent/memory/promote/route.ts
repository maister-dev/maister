import "server-only";

import {
  readVaultJson,
  vaultErrorResponse,
  vaultMutationResponse,
} from "@/lib/agent-memory-vault/http";
import { prepareInstallationExecutionVault } from "@/lib/agent-memory-vault/installation-access";
import { prepareProjectExecutionVault } from "@/lib/agent-memory-vault/project-access";
import {
  parseMemoryPromotion,
  promoteMemory,
} from "@/lib/agent-memory-vault/promotion";
import { getDb } from "@/lib/db/client";
import { MaisterError } from "@/lib/errors";
import { handleOwnedExt } from "@/lib/tokens/owned-ext-handler";

const endpoint = "POST /api/v1/ext/agent/memory/promote";
const scope = "agent_memory:propose";

export async function POST(request: Request) {
  return handleOwnedExt(
    request,
    { endpoint, method: "POST", scopeLabel: scope, admitInstallation: true },
    async ({ actor }) => {
      if (!actor.projectId && !actor.installationScope)
        throw new MaisterError(
          "UNAUTHORIZED",
          "Project-bound agent credential required",
        );
      const command = parseMemoryPromotion(await readVaultJson(request));

      return vaultMutationResponse(
        await promoteMemory(
          getDb(),
          { kind: "token", tokenId: actor.tokenId },
          command,
          actor.installationScope
            ? prepareInstallationExecutionVault(actor.tokenId, scope)
            : prepareProjectExecutionVault(actor, actor.projectId!, scope),
        ),
      );
    },
    (error) => vaultErrorResponse(error, endpoint),
  );
}
