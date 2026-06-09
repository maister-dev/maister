import "server-only";

import type { InferSelectModel } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";

import { capabilityRecords } from "@/lib/db/schema";

// M27/T-C1 (ADR-067): usage references for a platform MCP server, analogous to
// lib/acp-runners/usage.ts. A platform MCP is "in use" when a project has
// materialized it into its capability set — a `capability_records` row with
// kind=mcp, source=platform, capability_ref_id=<mcp id>. Deleting/disabling a
// referenced platform MCP would orphan that materialization, so it is refused
// (409). Soft-disabled records (`disabled_at` set) do NOT pin the definition.
type Db = {
  select: () => {
    from: <TTable extends PgTable>(
      table: TTable,
    ) => Promise<InferSelectModel<TTable>[]> | InferSelectModel<TTable>[];
  };
};

export type McpUsageReference = {
  readonly kind: "projectMaterialization";
  readonly projectId: string;
  readonly recordId: string;
  readonly mcpId: string;
};

type McpUsageInput = {
  readonly mcpId: string;
  readonly capabilityRecords: readonly {
    readonly id: string;
    readonly projectId: string;
    readonly kind: string;
    readonly source: string;
    readonly capabilityRefId: string;
    readonly disabledAt?: Date | null;
  }[];
};

export function collectMcpUsageReferences(
  input: McpUsageInput,
): McpUsageReference[] {
  const refs: McpUsageReference[] = [];

  for (const record of input.capabilityRecords) {
    if (record.kind !== "mcp") continue;
    if (record.source !== "platform") continue;
    if (record.capabilityRefId !== input.mcpId) continue;
    if (record.disabledAt) continue;

    refs.push({
      kind: "projectMaterialization",
      projectId: record.projectId,
      recordId: record.id,
      mcpId: input.mcpId,
    });
  }

  return refs;
}

export async function loadMcpUsageReferences(
  db: Db,
  mcpId: string,
): Promise<McpUsageReference[]> {
  const records = await db.select().from(capabilityRecords);

  return collectMcpUsageReferences({
    mcpId,
    capabilityRecords: records.map((record) => ({
      id: record.id,
      projectId: record.projectId,
      kind: record.kind,
      source: record.source,
      capabilityRefId: record.capabilityRefId,
      disabledAt: record.disabledAt ?? null,
    })),
  });
}
