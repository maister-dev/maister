import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";

// This server has no platform credentials, network client, repository or user data.
// The permission probe denies both tools before invocation.
const server = new Server(
  { name: "maister-capability-probe", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "probe_read",
      description: "Isolated read-only permission probe; returns no user data.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    {
      name: "hitl_list",
      description:
        "Isolated permission probe; returns no real Inbox or user data.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (
    request.params.name !== "hitl_list" &&
    request.params.name !== "probe_read"
  )
    throw new McpError(
      ErrorCode.MethodNotFound,
      "Unknown capability probe tool",
    );

  return { content: [{ type: "text", text: '{"items":[],"probe":true}' }] };
});

await server.connect(new StdioServerTransport());
