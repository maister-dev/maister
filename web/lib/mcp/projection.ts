import "server-only";

import type { InferSelectModel } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import type { PlatformMcpCapability } from "@/lib/capabilities/types";
import type { PlatformMcpServer } from "@/lib/db/schema";

import { platformMcpServers } from "@/lib/db/schema";

// M27/T-C3 (ADR-066): project the admin-managed `platform_mcp_servers` catalog
// (T-C1) into the capability pipeline as `source='platform'` MCP capabilities,
// replacing the legacy `.mcp.json` registry. The downstream upsert
// (`upsertCapabilitiesFromConfig`) reduces `env` to NAME-only `envKeys`
// (`redactedEnv`), so secret VALUES never reach `capability_records`.
type Db = {
  select: () => {
    from: <TTable extends PgTable>(
      table: TTable,
    ) => Promise<InferSelectModel<TTable>[]> | InferSelectModel<TTable>[];
  };
};

function stripEnvPrefix(ref: string): string {
  return ref.startsWith("env:") ? ref.slice(4) : ref;
}

// Map a stored row to the capability-config shape the resolver/materializer
// consume. `envKeys` (NAME references) become an `env` map keyed by the var
// NAME → `env:NAME` reference; the downstream `redactedEnv` keeps only the
// NAMES. (sse/http url/header carry-through lands in T-C4.)
export function platformMcpRowToCapability(
  row: PlatformMcpServer,
): PlatformMcpCapability {
  const env: Record<string, string> = {};

  for (const key of row.envKeys ?? []) {
    const name = stripEnvPrefix(key);

    env[name] = `env:${name}`;
  }

  return {
    id: row.id,
    kind: "mcp",
    label: row.id,
    source: "platform",
    command: row.command ?? undefined,
    args: row.args ?? [],
    env,
    agents: row.supportedAgents ?? ["claude", "codex"],
    enforceability: "enforced",
    selected_by_default: true,
  };
}

export async function loadPlatformMcpCapabilitiesFromDb(
  db: Db,
): Promise<PlatformMcpCapability[]> {
  const rows = await db.select().from(platformMcpServers);

  return rows.filter((row) => row.enabled).map(platformMcpRowToCapability);
}
