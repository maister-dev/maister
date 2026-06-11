import "server-only";

import type { InferSelectModel } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import type { PlatformMcpCapability } from "@/lib/capabilities/types";
import type { PlatformMcpServer } from "@/lib/db/schema";

import { ADAPTER_IDS } from "@/lib/acp-runners/adapter-support";
import { platformMcpServers } from "@/lib/db/schema";

// M27/T-C3 (ADR-067): project the admin-managed `platform_mcp_servers` catalog
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

// NAME references → an `env`/`headers` map keyed by the var/header NAME →
// `env:NAME` reference. The downstream `redactedEnv` keeps only the NAMES, so
// no secret VALUE ever reaches `capability_records`.
function refsToMap(
  keys: readonly string[] | undefined,
): Record<string, string> {
  const map: Record<string, string> = {};

  for (const key of keys ?? []) {
    const name = stripEnvPrefix(key);

    map[name] = `env:${name}`;
  }

  return map;
}

// Map a stored row to the capability-config shape the resolver/materializer
// consume — transport-aware (T-C4): stdio carries command/args/env; sse/http
// carry url/headers.
export function platformMcpRowToCapability(
  row: PlatformMcpServer,
): PlatformMcpCapability {
  const base = {
    id: row.id,
    kind: "mcp" as const,
    label: row.id,
    source: "platform" as const,
    transport: row.transport,
    agents: row.supportedAgents ?? [...ADAPTER_IDS],
    enforceability: "enforced" as const,
    selected_by_default: true,
  };

  if (row.transport === "sse" || row.transport === "http") {
    return {
      ...base,
      url: row.url ?? undefined,
      headers: refsToMap(row.headerKeys),
    };
  }

  return {
    ...base,
    command: row.command ?? undefined,
    args: row.args ?? [],
    env: refsToMap(row.envKeys),
  };
}

export async function loadPlatformMcpCapabilitiesFromDb(
  db: Db,
): Promise<PlatformMcpCapability[]> {
  const rows = await db.select().from(platformMcpServers);

  return rows.filter((row) => row.enabled).map(platformMcpRowToCapability);
}
