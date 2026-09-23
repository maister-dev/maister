// MCP facade entry point.
// Transport selection:
//   --stdio  or  MCP_TRANSPORT=stdio  → StdioServerTransport (local, env token)
//   default                            → StreamableHTTPServerTransport on :3001 (remote, per-request bearer)
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import pino from "pino";

import { httpAuthContext, type AuthContext } from "./auth";
import { dispatchTool, TOOL_SPECS } from "./tools";

const log = pino({
  level: process.env.LOG_LEVEL ?? "info",
  transport:
    process.env.NODE_ENV !== "production"
      ? { target: "pino-pretty", options: { colorize: true } }
      : undefined,
}).child({ service: "maister-mcp" });

const BASE_URL = process.env.MAISTER_API_BASE_URL ?? "http://localhost:3000";

// --- publish the canonical JSON Schemas and dispatch external facade tools ---

function buildServer(transportType: "stdio" | "http"): Server {
  const server = new Server(
    { name: "maister-mcp", version: "0.0.1" },
    { capabilities: { tools: {} } },
  );

  // A generic Zod record serializes to an empty object schema in the SDK.
  // Publish the JSON Schemas directly; the ext routes own input validation.
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: Object.entries(TOOL_SPECS).map(([name, spec]) => ({
      name,
      ...spec,
      execution: { taskSupport: "forbidden" as const },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async ({ params }, extra) => {
    const toolName = params.name;

    if (!Object.hasOwn(TOOL_SPECS, toolName)) {
      return {
        isError: true,
        content: [
          { type: "text" as const, text: `Tool ${toolName} not found` },
        ],
      };
    }
    let ctx: AuthContext;

    if (transportType === "stdio") {
      ctx = {
        transport: "stdio",
        env: process.env as {
          MAISTER_PROJECT_TOKEN?: string;
          MAISTER_ACCESS_TOKEN?: string;
        },
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
      args: params.arguments ?? {},
      ctx,
      baseUrl: BASE_URL,
      signal: extra.signal,
    });

    if (result.isError) {
      log.error(
        {
          tool: toolName,
          status: result.status,
          reason:
            result.publicBody?.details &&
            typeof result.publicBody.details === "object"
              ? (result.publicBody.details as { reason?: unknown }).reason
              : undefined,
        },
        "tool-error",
      );

      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text:
              toolName === "hitl_respond" && result.publicBody
                ? JSON.stringify(result.publicBody)
                : (result.message ?? `Error ${result.status}`),
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
  });

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
