import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { build } from "esbuild";

export async function buildCompiledMcp(): Promise<void> {
  const mcpRoot = fileURLToPath(new URL("../", import.meta.url));

  await build({
    absWorkingDir: mcpRoot,
    entryPoints: ["src/main.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
    outfile: "dist/main.js",
  });
}

/** Exercise the installed facade artifact with its declared SDK dependencies. */
export async function connectCompiledMcp(input: {
  baseUrl: string;
  token: string;
}): Promise<{ client: Client; close: () => Promise<void> }> {
  const mcpRoot = fileURLToPath(new URL("../", import.meta.url));
  const client = new Client({ name: "web-launch-bridge", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      fileURLToPath(new URL("../dist/main.js", import.meta.url)),
      "--stdio",
    ],
    cwd: mcpRoot,
    env: {
      NODE_ENV: "production",
      LOG_LEVEL: "silent",
      MAISTER_API_BASE_URL: input.baseUrl,
      MAISTER_PROJECT_TOKEN: input.token,
    },
  });
  const exited = new Promise<void>((resolve) => {
    transport.onclose = resolve;
  });

  try {
    await client.connect(transport);
  } catch (error) {
    await transport.close();
    throw error;
  }

  return {
    client,
    close: async () => {
      let deadline: ReturnType<typeof setTimeout> | undefined;

      try {
        await client.close();
        await Promise.race([
          exited,
          new Promise<never>((_, reject) => {
            deadline = setTimeout(
              () => reject(new Error("Compiled MCP child did not exit")),
              3000,
            );
          }),
        ]);
      } finally {
        clearTimeout(deadline);
      }
    },
  };
}
