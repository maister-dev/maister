import "server-only";

import type { NextResponse } from "next/server";

import { parseAgentSessionMemoryCommand } from "@/lib/agent-memory-vault/commands";
import {
  readVaultJson,
  vaultErrorResponse,
  vaultMutationResponse,
} from "@/lib/agent-memory-vault/http";
import { agentMemoryVaultLimits } from "@/lib/agent-memory-vault/limits";
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
      async resolveScopeLabel() {
        parsed = parseAgentSessionMemoryCommand(await readVaultJson(request));

        return parsed.command === "view"
          ? "agent_memory:read"
          : "agent_memory:write";
      },
    },
    async ({ actor }) => {
      if (!actor.projectId)
        throw new MaisterError(
          "UNAUTHORIZED",
          "Project-bound agent credential required",
        );
      if (!parsed)
        throw new MaisterError("CRASH", "Vault command was not validated");
      const db = getDb();

      if (parsed.command === "view")
        return privateJson(
          await viewAgentMemory(
            db,
            parsed,
            prepareProjectExecutionVault(
              actor,
              actor.projectId,
              "agent_memory:read",
            ),
          ),
        );

      return vaultMutationResponse(
        await applyVaultMutation(
          db,
          parsed,
          prepareProjectExecutionVault(
            actor,
            actor.projectId,
            "agent_memory:write",
          ),
          agentMemoryVaultLimits(),
        ),
      );
    },
    (error) => vaultErrorResponse(error, endpoint),
  );
}
