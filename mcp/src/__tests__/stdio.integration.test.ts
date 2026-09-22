import { once } from "node:events";
import { createServer, type Server } from "node:http";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { TOOL_SPECS } from "@/tools";

type CapturedRequest = {
  method?: string;
  url?: string;
  authorization?: string;
  body: Record<string, unknown>;
};

describe("MCP stdio wire contract", () => {
  let api: Server;
  let baseUrl: string;
  let client: Client;
  const requests: CapturedRequest[] = [];

  async function connectClient(token: string): Promise<Client> {
    const connected = new Client({ name: "wire-test", version: "1.0.0" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", "src/main.ts", "--stdio"],
      env: {
        NODE_ENV: "production",
        LOG_LEVEL: "silent",
        MAISTER_API_BASE_URL: baseUrl,
        MAISTER_PROJECT_TOKEN: token,
      },
    });

    try {
      await connected.connect(transport);

      return connected;
    } catch (error) {
      await transport.close();
      throw error;
    }
  }

  beforeAll(async () => {
    api = createServer(async (req, res) => {
      const chunks: Buffer[] = [];

      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      requests.push({
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
      });
      if (req.url?.includes("/hitl/") && req.url.endsWith("/respond")) {
        res.writeHead(409, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            code: "CONFLICT",
            message: "already owned",
            details: { reason: "permission_resume_in_flight" },
          }),
        );

        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ triageStatus: "triaged" }));
    });
    api.listen(0, "127.0.0.1");
    await once(api, "listening");
    const address = api.address();

    if (address === null || typeof address === "string") {
      throw new Error("Expected an HTTP fixture TCP address");
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
    client = await connectClient("mai_wire_test");
  });

  afterAll(async () => {
    await client?.close();
    if (api?.listening) {
      await new Promise<void>((resolve, reject) => {
        api.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("publishes every tool's complete schema through tools/list", async () => {
    const { tools } = await client.listTools();

    expect(
      tools.map(({ name, description, inputSchema }) => ({
        name,
        description,
        inputSchema,
      })),
    ).toEqual(
      Object.entries(TOOL_SPECS).map(([name, spec]) => ({ name, ...spec })),
    );
  });

  it.each([true, false])(
    "forwards enqueue=%s and nullable metadata without changing their types",
    async (enqueue) => {
      const result = await client.callTool({
        name: "triage_set",
        arguments: {
          slug: "wire-project",
          taskId: "task-1",
          flowId: "aif-dev",
          runnerId: "claude-code",
          enqueue,
          priority: null,
          confidence: enqueue ? 0.92 : null,
        },
      });

      expect(result.isError).not.toBe(true);
      expect(requests.at(-1)).toEqual({
        method: "POST",
        url: "/api/v1/ext/projects/wire-project/tasks/task-1/triage",
        authorization: "Bearer mai_wire_test",
        body: {
          flowId: "aif-dev",
          runnerId: "claude-code",
          enqueue,
          priority: null,
          confidence: enqueue ? 0.92 : null,
        },
      });
    },
  );

  it("rejects a call without credentials before reaching REST", async () => {
    const unauthenticated = await connectClient("");
    const count = requests.length;

    try {
      const result = await unauthenticated.callTool({
        name: "task_list",
        arguments: { slug: "wire-project" },
      });

      expect(result.isError).toBe(true);
      expect(requests).toHaveLength(count);
    } finally {
      await unauthenticated.close();
    }
  });

  it("preserves the complete HITL refusal body through callTool", async () => {
    const result = await client.callTool({
      name: "hitl_respond",
      arguments: {
        runId: "run-1",
        hitlRequestId: "hitl-1",
        optionId: "allow",
      },
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      {
        type: "text",
        text: JSON.stringify({
          code: "CONFLICT",
          message: "already owned",
          details: { reason: "permission_resume_in_flight" },
        }),
      },
    ]);
  });

  it("rejects an unknown tool before reaching REST", async () => {
    const count = requests.length;
    const result = await client.callTool({ name: "unknown_tool" });

    expect(result.isError).toBe(true);
    expect(requests).toHaveLength(count);
  });
});
