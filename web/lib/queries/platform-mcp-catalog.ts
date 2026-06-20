import "server-only";

import { asc } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import { platformMcpServers } from "@/lib/db/schema";

// Client-safe projection of an admin-managed `platform_mcp_servers` row for the
// MCP-template editor (M36 T2.5). Carries only catalog SHAPE — transport,
// command/args/url, and the env/header var NAMES (`envKeys`/`headerKeys`).
// Secret VALUES are never stored on the row and never projected; the editor
// materializes `env:NAME` references from these names only (T2.1: provenance is
// display-only — `platform_mcp_server_id` is NOT persisted).
export type PlatformMcpCatalogEntry = {
  id: string;
  transport: "stdio" | "sse" | "http";
  command: string | null;
  args: string[];
  url: string | null;
  envKeys: string[];
  headerKeys: string[];
  enabled: boolean;
};

export async function listPlatformMcpCatalog(): Promise<
  PlatformMcpCatalogEntry[]
> {
  const db = getDb() as unknown as {
    select: () => {
      from: (table: typeof platformMcpServers) => {
        orderBy: (
          col: ReturnType<typeof asc>,
        ) => Promise<(typeof platformMcpServers.$inferSelect)[]>;
      };
    };
  };

  const rows = await db
    .select()
    .from(platformMcpServers)
    .orderBy(asc(platformMcpServers.id));

  return rows.map((row) => ({
    id: row.id,
    transport: row.transport,
    command: row.command,
    args: row.args,
    url: row.url,
    envKeys: row.envKeys,
    headerKeys: row.headerKeys,
    enabled: row.enabled,
  }));
}
