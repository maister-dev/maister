import type { McpDistribution } from "../../runtime/mcp-distribution";
import type { McpServerInput } from "./types";

import { join } from "node:path";

import { prepareMcpDistribution } from "./mcp-distribution";

export async function prepareWorkloadMcp(
  distribution: McpDistribution,
  runtimeRoot: string,
  assertCurrent: () => void,
): Promise<{ entry: string; cacheHit: boolean }> {
  return prepareMcpDistribution(distribution, {
    allowedDigests: (process.env.MAISTER_MCP_ALLOWED_DIGESTS ?? "")
      .split(",")
      .map((d) => d.trim())
      .filter(Boolean),
    cacheRoot:
      process.env.MAISTER_MCP_CACHE_DIR ?? join(runtimeRoot, "mcp-cache"),
    assertCurrent,
  });
}

export async function workloadMcpServer(
  server: McpServerInput,
  runtimeRoot: string,
  assertCurrent: () => void,
): Promise<McpServerInput> {
  if (server.distribution) {
    const { entry } = await prepareWorkloadMcp(
      server.distribution,
      runtimeRoot,
      assertCurrent,
    );

    return {
      ...server,
      command: process.execPath,
      args: [entry, ...(server.args ?? [])],
    };
  }

  return server;
}
