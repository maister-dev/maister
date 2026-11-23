import type { McpDistribution } from "../../runtime/mcp-distribution";
import type { McpServerInput } from "./types";

import { access } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { prepareMcpDistribution } from "./mcp-distribution";
import { SupervisorError } from "./types";

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
  if (server.command !== "maister:host-facade") return server;
  if (
    server.platformOrigin !== "maister_facade" ||
    server.name !== "maister" ||
    server.transport !== "stdio"
  )
    throw new SupervisorError(
      "PRECONDITION",
      "The workload facade requires server-generated platform provenance",
    );
  const api = process.env.MAISTER_WORKLOAD_API_BASE_URL;

  if (!api)
    throw new SupervisorError(
      "PRECONDITION",
      "Configure MAISTER_WORKLOAD_API_BASE_URL on the assigned supervisor",
    );
  const url = new URL(api);

  if (
    url.username ||
    url.password ||
    url.hash ||
    url.search ||
    url.pathname !== "/" ||
    !(
      url.protocol === "https:" ||
      (url.protocol === "http:" &&
        ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
    )
  )
    throw new SupervisorError(
      "PRECONDITION",
      "Workload API requires an HTTPS endpoint or loopback tunnel",
    );
  const entry = fileURLToPath(
    new URL("../../mcp/dist/main.js", import.meta.url),
  );

  await access(entry);

  return {
    ...server,
    command: process.execPath,
    args: [entry, "--stdio"],
    env: { ...server.env, MAISTER_API_BASE_URL: url.origin },
  };
}
