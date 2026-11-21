import "server-only";

import type { InstallationVaultRoute } from "@/lib/agent-memory-vault/installation-route";

import { withInstallationVault } from "@/lib/agent-memory-vault/installation-route";
import { vaultRevisionDetail } from "@/lib/agent-memory-vault/history";
import { privateJson } from "@/lib/api/private-json";
import { getDb } from "@/lib/db/client";
import { decodeRouteParam } from "@/lib/route-params";

type RevisionRoute = {
  params: Promise<
    Awaited<InstallationVaultRoute["params"]> & { revisionId: string }
  >;
};

export async function GET(request: Request, route: RevisionRoute) {
  return withInstallationVault(route, "read", async (prepare) => {
    const revisionId = decodeRouteParam(
      (await route.params).revisionId,
      "revisionId",
    );

    return privateJson(
      await vaultRevisionDetail(
        getDb(),
        revisionId,
        prepare,
        new URL(request.url).searchParams.get("noteId") ?? undefined,
      ),
    );
  });
}
