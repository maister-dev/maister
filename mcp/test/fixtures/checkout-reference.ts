import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

/** Loopback-only, no-input design reference for the synthetic checkout scenario. */
export async function startCheckoutReference() {
  const receipt = randomUUID();
  let calls = 0;
  const failures: unknown[] = [];
  const http = createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/mcp") {
      res.writeHead(405).end();

      return;
    }
    const server = new McpServer({
      name: "checkout-reference",
      version: "1.0.0",
    });

    server.registerTool(
      "read_design_reference",
      { description: "Read a synthetic checkout reference", inputSchema: {} },
      async () => {
        calls++;

        return {
          content: [
            {
              type: "text",
              text: `Use a link to the next checkout step. Reference ${receipt}.`,
            },
          ],
        };
      },
    );
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    res.once("close", () => {
      void server.close().catch((error) => failures.push(error));
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (error) {
      if (!res.headersSent) res.writeHead(500);
      res.end();
      failures.push(error);
    }
  });

  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  const address = http.address();

  if (!address || typeof address === "string")
    throw new Error("Missing fixture listener");

  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    receipt,
    calls: () => calls,
    close: async () => {
      const closed = once(http, "close");

      http.close();
      http.closeAllConnections();
      await closed;
      if (failures.length)
        throw new AggregateError(failures, "Checkout MCP fixture failed");
    },
  };
}
