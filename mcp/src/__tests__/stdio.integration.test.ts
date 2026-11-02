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
      if (req.url?.endsWith("/human-asks")) {
        res.writeHead(422, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            code: "CONFIG",
            message: "Use MAIster form schema, not JSON Schema",
            details: {
              reason: "human_ask_body_invalid",
              format: "form_schema_v1",
              issues: [
                { path: ["schema", "schemaVersion"], code: "invalid_value" },
              ],
            },
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

  it("publishes and forwards a complete qualification without dropping a null revision", async () => {
    const { tools } = await client.listTools();
    const triage = tools.find((tool) => tool.name === "triage_set");
    const qualification = {
      schemaVersion: 1,
      requestType: "feature",
      decision: "ready",
      checks: [
        "goal_scope",
        "acceptance",
        "consistency",
        "constraints_dependencies",
        "duplicates",
        "relevance",
        "bug_evidence",
      ].map((dimension) => ({
        dimension,
        state: dimension === "bug_evidence" ? "not_applicable" : "pass",
        rationale:
          dimension === "bug_evidence"
            ? "This feature request does not report a bug."
            : "The request is supported by the current repository assessment.",
        evidenceIds: dimension === "bug_evidence" ? [] : ["repository-1"],
      })),
      reasonCodes: [],
      nextActions: [],
      evidenceRefs: [
        {
          id: "repository-1",
          kind: "repository",
          reference: "src/feature.ts@0123456789abcdef",
        },
      ],
    };
    const verdict = {
      requestKey: "b486bbac-b29a-4e1d-a384-a07a4202ad48",
      expectedInputRevision: 3,
      expectedQualificationRevision: null,
      qualification,
      flowId: "aif-dev",
      runnerId: "claude-code",
      baseBranch: "main",
      enqueue: false,
    };

    expect(triage?.inputSchema).toMatchObject({
      properties: {
        requestKey: { type: "string", format: "uuid" },
        expectedInputRevision: { type: "integer", minimum: 1 },
        expectedQualificationRevision: { type: ["integer", "null"] },
        qualification: {
          type: "object",
          required: [
            "schemaVersion",
            "requestType",
            "decision",
            "checks",
            "reasonCodes",
            "nextActions",
            "evidenceRefs",
          ],
        },
      },
    });
    const result = await client.callTool({
      name: "triage_set",
      arguments: { slug: "wire-project", taskId: "task-1", ...verdict },
    });

    expect(result.isError).not.toBe(true);
    expect(requests.at(-1)).toEqual({
      method: "POST",
      url: "/api/v1/ext/projects/wire-project/tasks/task-1/triage",
      authorization: "Bearer mai_wire_test",
      body: verdict,
    });
  });

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

  it("preserves actionable Human-ask schema diagnostics through callTool", async () => {
    const result = await client.callTool({
      name: "ask_human",
      arguments: {
        slug: "demo",
        taskId: "task-1",
        question: "Which scope should delivery use?",
        schema: { schemaVersion: 1, fields: [] },
      },
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      {
        type: "text",
        text: JSON.stringify({
          code: "CONFIG",
          message: "Use MAIster form schema, not JSON Schema",
          details: {
            reason: "human_ask_body_invalid",
            format: "form_schema_v1",
            issues: [
              { path: ["schema", "schemaVersion"], code: "invalid_value" },
            ],
          },
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
