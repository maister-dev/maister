import "server-only";

import { vaultErrorResponse } from "@/lib/agent-memory-vault/http";
import { readInstallationResource } from "@/lib/agents/installation-facade";
import { privateJson } from "@/lib/api/private-json";
import { getDb } from "@/lib/db/client";
import { handleOwnedExt } from "@/lib/tokens/owned-ext-handler";

const endpoint = "GET /api/v1/ext/observatory/summary";

export async function GET(request: Request) {
  return handleOwnedExt(
    request,
    {
      endpoint,
      method: "GET",
      scopeLabel: "observatory:read",
      admitInstallation: true,
    },
    async ({ actor }) =>
      privateJson(
        await readInstallationResource(
          getDb(),
          actor.tokenId,
          "observatory",
          new URL(request.url).searchParams,
        ),
      ),
    (error) => vaultErrorResponse(error, endpoint),
  );
}
