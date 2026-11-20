import "server-only";

import type { ProjectVaultRoute } from "@/lib/agent-memory-vault/project-route";

import {
  readVaultJson,
  vaultErrorResponse,
  vaultMutationResponse,
} from "@/lib/agent-memory-vault/http";
import { prepareHumanProjectVault } from "@/lib/agent-memory-vault/project-access";
import {
  parseMemoryPromotion,
  promoteMemory,
} from "@/lib/agent-memory-vault/promotion";
import { requireActiveSession } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import { decodeRouteParam } from "@/lib/route-params";

export async function POST(request: Request, route: ProjectVaultRoute) {
  try {
    const user = await requireActiveSession();
    const { slug, agentId } = await route.params;
    const input = parseMemoryPromotion(await readVaultJson(request));
    const prepare = prepareHumanProjectVault({
      slug,
      agentId: decodeRouteParam(agentId, "agentId"),
      userId: user.id,
      action: "editSettings",
    });

    return vaultMutationResponse(
      await promoteMemory(
        getDb(),
        { kind: "user", userId: user.id },
        input,
        prepare,
      ),
    );
  } catch (error) {
    return vaultErrorResponse(error, "project agent vault promotion");
  }
}
