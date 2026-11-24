import "server-only";

import type { SqlTransaction } from "@/lib/db/sql-types";
import type { CapabilityCatalogRecord } from "./types";

import { loadSelectableCapabilities, type McpBindingInput } from "./resolver";
import { withBoundPlatformMcpRecords } from "./bound-platform-mcps";

import { loadProjectMcpBindings } from "@/lib/mcp/binding-service";
import { readPackageMcpScopes } from "@/lib/packages/mcp-scope";

export async function loadScratchCapabilityCatalog(
  projectId: string,
  db: SqlTransaction,
): Promise<{
  catalog: CapabilityCatalogRecord[];
  mcpBindings: McpBindingInput[];
}> {
  const [records, scopes, mcpBindings] = await Promise.all([
    loadSelectableCapabilities(projectId, db),
    readPackageMcpScopes(db, projectId),
    loadProjectMcpBindings(projectId, db),
  ]);
  const scoped = new Set(scopes.map((row) => row.refId));
  const shared = new Set(
    scopes.filter((row) => row.effective === "project").map((row) => row.refId),
  );
  const disconnected = new Set(
    mcpBindings
      .filter((binding) => !binding.enabled)
      .map((binding) => binding.refId),
  );
  const catalog = mcpBindings.some(
    (binding) => binding.targetKind === "platform",
  )
    ? await withBoundPlatformMcpRecords(db, projectId, records)
    : records;

  return {
    catalog: catalog.map((record) => {
      if (record.kind !== "mcp") return record;
      const ref = record.capabilityRefId;

      return {
        ...record,
        selectedByDefault:
          !disconnected.has(ref) &&
          (scoped.has(ref) ? shared.has(ref) : record.selectedByDefault),
      };
    }),
    mcpBindings,
  };
}
