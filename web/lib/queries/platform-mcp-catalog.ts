import "server-only";

import { asc } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import { platformMcpServers } from "@/lib/db/schema";

// Client-safe projection of an admin-managed `platform_mcp_servers` row for the
// MCP-template editor (M36 T2.5). Carries only catalog SHAPE — transport,
// command/args/url and the env/header VALUE maps (ADR-177). A package is
// shareable, so the Studio editor never copies a literal into a template: a
// reference is copied as-is and a literal is converted to `env:<KEY>` (D28).
// (T2.1: provenance is display-only — `platform_mcp_server_id` is NOT
// persisted.)
export type PlatformMcpCatalogEntry = {
  id: string;
  description: string | null;
  transport: "stdio" | "sse" | "http";
  command: string | null;
  args: string[];
  url: string | null;
  env: Record<string, string>;
  headers: Record<string, string>;
  bearerTokenEnv: string | null;
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
    description: row.description,
    transport: row.transport,
    command: row.command,
    args: row.args,
    url: row.url,
    env: row.env,
    headers: row.headers,
    bearerTokenEnv: row.bearerTokenEnv,
    enabled: row.enabled,
  }));
}
