import type { platformAcpRunners } from "@/lib/db/schema";
import type { RunnerCatalogEntry } from "@/lib/acp-runners/resolve";

import { getAdapterSupportById } from "@/lib/acp-runners/adapter-support";

export function runnerCatalogEntry(
  row: typeof platformAcpRunners.$inferSelect,
): RunnerCatalogEntry {
  return {
    id: row.id,
    adapter: row.adapter,
    capabilityAgent: row.capabilityAgent,
    model: row.model,
    env: row.env,
    provider: row.provider,
    providerKind: row.provider?.kind ?? "anthropic",
    permissionPolicy: row.permissionPolicy,
    readOnlyCapable:
      getAdapterSupportById(row.adapter)?.readOnlyCapable === true,
    enabled: row.enabled,
    ready: row.readinessStatus === "Ready",
  };
}
