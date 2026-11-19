import "server-only";

import type { InstallationVaultRoute } from "@/lib/agent-memory-vault/installation-route";
import { withInstallationVault } from "@/lib/agent-memory-vault/installation-route";

import { memoryIndexReaders } from "@/lib/agent-memory-vault/index-route";
import { privateJson } from "@/lib/api/private-json";

export async function GET(request: Request, route: InstallationVaultRoute) {
  return withInstallationVault(route, "read", async (prepare) =>
    privateJson(await memoryIndexReaders.search(request, prepare)),
  );
}
