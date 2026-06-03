// MCP facade entry point.
// Transport selection:
//   --stdio  or  MCP_TRANSPORT=stdio  → StdioServerTransport (local, env token)
//   default                            → StreamableHTTPServerTransport on :3001 (remote, per-request bearer)
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import pino from "pino";
import { z } from "zod";

import { httpAuthContext, type AuthContext } from "@/auth";
import { dispatchTool, TOOL_SPECS } from "@/tools";

const log = pino({
  level: process.env.LOG_LEVEL ?? "info",
  transport:
    process.env.NODE_ENV !== "production"
      ? { target: "pino-pretty", options: { colorize: true } }
      : undefined,
}).child({ service: "maister-mcp" });

const BASE_URL = process.env.MAISTER_API_BASE_URL ?? "http://localhost:3000";

// --- build McpServer and register all 8 tools ---

function buildServer(transportType: "stdio" | "http"): McpServer {
  const server = new McpServer({ name: "maister-mcp", version: "0.0.1" });

  for (const [toolName, spec] of Object.entries(TOOL_SPECS)) {
    // Use a zod passthrough object so args are typed as Record<string, unknown>.
    // The input schema from spec is included in the tool definition as-is
    // (the SDK accepts a ZodRawShape — so we build one from a z.record).
    // We use z.object({}).passthrough() to accept any args without SDK validation
    // overhead; our own dispatchTool handles the routing.
    const inputSchema = z.record(z.unknown());

    server.registerTool(
      toolName,
      {
        description: spec.description,
        inputSchema,
      },
      async (args, extra) => {
        let ctx: AuthContext;

        if (transportType === "stdio") {
          ctx = {
            transport: "stdio",
            env: process.env as { MAISTER_PROJECT_TOKEN?: string },
          };
        } else {
          // Under Streamable-HTTP, headers are lowercased in the RequestInfo.
          // extra.requestInfo?.headers is IsomorphicHeaders = Record<string, string | string[] | undefined>
          const httpCtx = httpAuthContext(
            extra.requestInfo?.headers["authorization"],
          );

          if (!httpCtx.inboundAuthorization) {
            log.warn({ tool: toolName }, "rejected-no-bearer");
          }

          ctx = httpCtx;
        }

        log.info({ tool: toolName }, "tool-invoke");

        const result = await dispatchTool({
          name: toolName,
          args: args as Record<string, unknown>,
          ctx,
          baseUrl: BASE_URL,
          signal: extra.signal,
        });

        if (result.isError) {
          log.error({ tool: toolName, status: result.status }, "tool-error");

          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: result.message ?? `Error ${result.status}`,
              },
            ],
          };
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result),
            },
          ],
        };
      },
    );
  }

  return server;
}

// --- transport selection ---

const useStdio =
  process.argv.includes("--stdio") || process.env.MCP_TRANSPORT === "stdio";

if (useStdio) {
  const server = buildServer("stdio");
  const transport = new StdioServerTransport();

  await server.connect(transport);
  log.info("mcp-stdio-ready");
} else {
  const MCP_PORT = parseInt(process.env.MCP_PORT ?? "3001", 10);

  // Stateless Streamable-HTTP: every POST /mcp is self-contained.
  // ADR-047: NEVER fall back to an env token under HTTP — if the bearer
  // is missing the tool itself returns 401, the server never consults env.
  const httpServer = createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/mcp") {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
      });
      const server = buildServer("http");

      await server.connect(transport);
      await transport.handleRequest(req, res);
    } else if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  httpServer.listen(MCP_PORT, "0.0.0.0", () => {
    log.info({ port: MCP_PORT }, "mcp-http-ready");
  });
}
