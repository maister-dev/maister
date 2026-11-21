import type { Tool } from "@modelcontextprotocol/sdk/types.js";

import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { INSTALLATION_SCOPE_TOOLS } from "../../runtime/installation-agent-tools";
import { TOOLSETS } from "../src/toolsets";
import { toolNamesForToolset, toolSpecForToolset } from "../src/tools";

const [command, ...args] = process.argv.slice(2);
const defaultEntry = fileURLToPath(new URL("../dist/main.js", import.meta.url));

for (const toolset of [undefined, ...Object.keys(TOOLSETS)]) {
  const scopes =
    toolset === "installation" ? Object.keys(INSTALLATION_SCOPE_TOOLS) : [];
  const transport = new StdioClientTransport({
    command: command ?? process.execPath,
    args: command === undefined ? [defaultEntry, "--stdio"] : args,
    env: {
      NODE_ENV: "production",
      LOG_LEVEL: "silent",
      MAISTER_MCP_TOOLSET: toolset ?? "",
      MAISTER_INSTALLATION_SCOPES: scopes.join(","),
    },
  });
  const client = new Client({
    name: "maister-mcp-contract-check",
    version: "1",
  });
  const label = toolset ?? "default";
  const signal = AbortSignal.timeout(8_000);

  try {
    await client.connect(transport, { signal });
    const tools: Tool[] = [];
    let cursor: string | undefined;

    do {
      const page = await client.listTools({ cursor }, { signal });

      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    const names = toolNamesForToolset(toolset, scopes);

    assert.deepEqual(
      tools.map(({ name }) => name).sort(),
      names.sort(),
      `${label} MCP tool catalog differs from this release`,
    );
    for (const { name, inputSchema } of tools) {
      assert.deepEqual(
        inputSchema,
        toolSpecForToolset(name, toolset).inputSchema,
        `${label}/${name} input schema differs from this release`,
      );
    }
    process.stdout.write(
      `Verified MCP tools/list for ${label} (${tools.length} tools)\n`,
    );
  } finally {
    await transport.close();
  }
}
