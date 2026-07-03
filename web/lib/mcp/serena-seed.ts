import "server-only";

import pino from "pino";

import { platformMcpServers } from "@/lib/db/schema";
import { getDb } from "@/lib/db/client";

const log = pino({
  name: "mcp:serena-seed",
  level: process.env.LOG_LEVEL ?? "info",
});

export const SERENA_MCP_SEED = {
  id: "serena",
  transport: "stdio",
  command: "uvx",
  args: [
    "--from",
    "git+https://github.com/oraios/serena",
    "serena",
    "start-mcp-server",
    "--context",
    "ide-assistant",
  ],
  envKeys: [],
  enabled: false,
  trustStatus: "untrusted",
  readinessStatus: "Unknown",
  readinessReasons: [
    "Seeded disabled by default; enable and trust explicitly before execution.",
  ],
} as const;

export async function ensureSerenaPlatformMcpSeed(opts?: {
  db?: any;
}): Promise<{ id: "serena"; created: boolean; skipped: boolean }> {
  const db = opts?.db ?? getDb();
  const inserted = await db
    .insert(platformMcpServers)
    .values(SERENA_MCP_SEED)
    .onConflictDoNothing()
    .returning({ id: platformMcpServers.id });
  const created = inserted.length > 0;

  log.info(
    { id: SERENA_MCP_SEED.id, created, skipped: !created },
    "serena platform MCP seed ensured",
  );

  return { id: SERENA_MCP_SEED.id, created, skipped: !created };
}
