import "server-only";

import type { NextResponse } from "next/server";
import type { ProjectVaultRoute } from "@/lib/agent-memory-vault/project-route";

import { parseAgentMemoryMutation } from "@/lib/agent-memory-vault/commands";
import {
  readVaultJson,
  vaultMutationResponse,
} from "@/lib/agent-memory-vault/http";
import { agentMemoryVaultLimits } from "@/lib/agent-memory-vault/limits";
import { withProjectVault } from "@/lib/agent-memory-vault/project-route";
import { applyVaultMutation } from "@/lib/agent-memory-vault/store";
import { getDb } from "@/lib/db/client";

export async function POST(
  request: Request,
  route: ProjectVaultRoute,
): Promise<NextResponse> {
  return withProjectVault(route, "editSettings", async (prepare) =>
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
