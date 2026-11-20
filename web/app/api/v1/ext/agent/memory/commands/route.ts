import "server-only";

import type { NextResponse } from "next/server";

import { parseAgentSessionMemoryCommand } from "@/lib/agent-memory-vault/commands";
import {
  readVaultJson,
  vaultErrorResponse,
  vaultMutationResponse,
} from "@/lib/agent-memory-vault/http";
import { agentMemoryVaultLimits } from "@/lib/agent-memory-vault/limits";
import { prepareInstallationExecutionVault } from "@/lib/agent-memory-vault/installation-access";
import { prepareProjectExecutionVault } from "@/lib/agent-memory-vault/project-access";
import { applyVaultMutation } from "@/lib/agent-memory-vault/store";
import { viewAgentMemory } from "@/lib/agent-memory-vault/view";
import { privateJson } from "@/lib/api/private-json";
import { getDb } from "@/lib/db/client";
import { MaisterError } from "@/lib/errors";
import { handleOwnedExt } from "@/lib/tokens/owned-ext-handler";

const endpoint = "POST /api/v1/ext/agent/memory/commands";

export async function POST(request: Request): Promise<NextResponse> {
  let parsed: ReturnType<typeof parseAgentSessionMemoryCommand> | undefined;

  return handleOwnedExt(
    request,
    {
      endpoint,
      method: "POST",
      scopeLabel: "agent_memory:write",
      admitInstallation: true,
      async resolveScopeLabel({ actor }) {
        parsed = parseAgentSessionMemoryCommand(await readVaultJson(request));

        return parsed.command === "view"
          ? "agent_memory:read"
          : actor.installationScope
            ? "agent_memory:propose"
            : "agent_memory:write";
      },
    },
    async ({ actor }) => {
      if (!actor.projectId && !actor.installationScope)
        throw new MaisterError(
          "UNAUTHORIZED",
          "Project-bound agent credential required",
        );
      if (!parsed)
        throw new MaisterError("CRASH", "Vault command was not validated");
      const db = getDb();
      const action =
        parsed.command === "view" ? "agent_memory:read" : "agent_memory:write";
      const prepare = actor.installationScope
        ? prepareInstallationExecutionVault(
            actor.tokenId,
            parsed.command === "view"
              ? "agent_memory:read"
              : "agent_memory:propose",
          )
        : prepareProjectExecutionVault(actor, actor.projectId!, action);

      if (parsed.command === "view")
        return privateJson(await viewAgentMemory(db, parsed, prepare));

      return vaultMutationResponse(
        await applyVaultMutation(db, parsed, prepare, agentMemoryVaultLimits()),
      );
    },
    (error) => vaultErrorResponse(error, endpoint),
  );
}
