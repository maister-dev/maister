import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

import { once } from "node:events";
import { createServer, type Server } from "node:http";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  buildCompiledMcp,
  connectCompiledMcp,
} from "../../test-support/compiled-client";

import { TOOL_SPECS } from "@/tools";

type CapturedRequest = {
  method?: string;
  url?: string;
  authorization?: string;
  operationKey?: string;
  body: Record<string, unknown>;
};

describe("MCP stdio wire contract", () => {
  let api: Server;
  let baseUrl: string;
  let client: Client;
  const requests: CapturedRequest[] = [];
  const processClosers = new WeakMap<Client, () => Promise<void>>();

  async function closeClient(connected: Client): Promise<void> {
    const close = processClosers.get(connected);

    if (!close) throw new Error("Compiled MCP cleanup is missing");
    await close();
  }

  async function connectClient(token: string): Promise<Client> {
    const connected = await connectCompiledMcp({ baseUrl, token });

    processClosers.set(connected.client, connected.close);

    return connected.client;
  }

  beforeAll(async () => {
    await buildCompiledMcp();
    api = createServer(async (req, res) => {
      const chunks: Buffer[] = [];

      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      requests.push({
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization,
        ...(req.headers["idempotency-key"]
          ? { operationKey: String(req.headers["idempotency-key"]) }
          : {}),
        body: chunks.length
          ? JSON.parse(Buffer.concat(chunks).toString("utf8"))
          : {},
      });
      if (req.url?.startsWith("/api/v1/ext/task-launch-intents")) {
        const refused = requests.at(-1)?.body.taskId === "unqualified-task";

        res.writeHead(refused ? 409 : 202, {
          "Content-Type": "application/json",
        });
        res.end(
          JSON.stringify(
            refused
              ? {
                  code: "PRECONDITION",
                  message: "Qualification is required",
                  details: {
                    reason: "qualification_missing",
                    nextAction: "send_to_triage",
                  },
                }
              : { intentId: "intent-1", basis: "automatic", state: "queued" },
          ),
        );

        return;
      }
      if (
        req.url === "/api/v1/ext/runs/delegate" ||
        req.url === "/api/v1/ext/runs/plan"
      ) {
        res.writeHead(202, { "Content-Type": "application/json" });
        const receipt = {
          accepted: true,
          intentId: "child-intent",
          runId: null,
          childRunId: null,
        };

        res.end(
          JSON.stringify(
            req.url.endsWith("/plan")
              ? { tasks: [{ key: "child", taskId: "child-task", ...receipt }] }
              : { childTaskId: "child-task", status: "Queued", ...receipt },
          ),
        );

        return;
      }
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
    if (client) await closeClient(client);
    if (api?.listening) {
      await new Promise<void>((resolve, reject) => {
        api.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("forwards delegated operation keys and preserves queued receipts while rejecting forged authority locally", async () => {
    const args = {
      target: { flowId: "delivery" },
      mode: "task",
      prompt: "Perform the scoped child request",
      operationKey: "delegate-decision",
    };
    const result = await client.callTool({
      name: "run_delegate",
      arguments: args,
    });

    expect(result).toMatchObject({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            childTaskId: "child-task",
            status: "Queued",
            accepted: true,
            intentId: "child-intent",
            runId: null,
            childRunId: null,
          }),
        },
      ],
    });
    expect(requests.at(-1)).toMatchObject({
      url: "/api/v1/ext/runs/delegate",
      operationKey: args.operationKey,
      body: { target: args.target, mode: args.mode, prompt: args.prompt },
    });
    const count = requests.length;

    for (const invalid of [
      { ...args, actorUserId: "human" },
      { ...args, manual: true },
      { ...args, operationKey: "x".repeat(257) },
      { target: args.target, mode: args.mode, prompt: args.prompt },
    ]) {
      const refused = await client.callTool({
        name: "run_delegate",
        arguments: invalid,
      });

      expect(refused).toMatchObject({
        isError: true,
        content: [
          {
            type: "text",
            text: expect.stringContaining(
              "delegation_launch_arguments_invalid",
            ),
          },
        ],
      });
    }
    expect(requests.length).toBe(count);
    const planned = await client.callTool({
      name: "run_plan",
      arguments: {
        operationKey: "plan-decision",
        tasks: [
          {
            key: "child",
            target: args.target,
            prompt: args.prompt,
            dependsOn: [],
          },
        ],
      },
    });

    expect(planned.isError).not.toBe(true);
    expect(requests.at(-1)).toMatchObject({
      url: "/api/v1/ext/runs/plan",
      operationKey: "plan-decision",
    });
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

  it("routes automatic launch, status, replacement and cancellation with complete frozen settings", async () => {
    const choices = {
      taskId: "task-1",
      flowId: "flow/with space",
      runnerId: "runner-1",
      packageVersions: { "cut/with space": "keep" },
    };
    const preview = await client.callTool({
      name: "task_launch_options",
      arguments: choices,
    });

    expect(preview.isError).not.toBe(true);
    expect(requests.at(-1)).toMatchObject({
      method: "GET",
      url: `/api/v1/ext/task-launch-intents/options?${new URLSearchParams({ taskId: choices.taskId, flowId: choices.flowId, runnerId: choices.runnerId, packageVersions: JSON.stringify(choices.packageVersions) })}`,
      body: {},
    });
    const settings = {
      taskId: "task-1",
      expectedTaskRevision: 3,
      expectedSettingsToken: "settings-1",
      flowId: "aif-bugfix",
      runnerId: "codex-sol",
      baseBranch: "main",
      baseCommit: "a".repeat(40),
      targetBranch: "main",
      deliveryPolicy: {
        strategy: "pull_request",
        push: "on_success",
        trigger: "auto_on_ready",
        targetBranch: null,
      },
      executionPolicy: {
        preset: "assisted",
        overrides: {
          onBudgetBreach: "terminate_restorable",
          budget: {
            run: { maxTokens: 1000, warnAtPct: 80 },
            task: { maxTokens: null },
          },
        },
      },
      autoPromote: true,
      brainContext: false,
    };
    const key = "k".repeat(256);
    const accepted = await client.callTool({
      name: "task_launch",
      arguments: { ...settings, operationKey: key },
    });

    expect(accepted.isError).not.toBe(true);
    expect(requests.at(-1)).toEqual({
      method: "POST",
      url: "/api/v1/ext/task-launch-intents",
      authorization: "Bearer mai_wire_test",
      operationKey: key,
      body: settings,
    });
    const intentId = "intent/with space";

    for (const [name, method, suffix, body] of [
      ["task_launch_status", "GET", "", {}],
      [
        "task_launch_replace",
        "POST",
        "/replace",
        { ...settings, expectedStateVersion: 1 },
      ],
      ["task_launch_cancel", "POST", "/cancel", { expectedStateVersion: 2 }],
    ] as const) {
      const result = await client.callTool({
        name,
        arguments: {
          intentId,
          ...body,
          ...(method === "POST" ? { operationKey: `${key.slice(1)}x` } : {}),
        },
      });

      expect(result.isError).not.toBe(true);
      expect(requests.at(-1)).toEqual({
        method,
        url: `/api/v1/ext/task-launch-intents/${encodeURIComponent(intentId)}${suffix}`,
        authorization: "Bearer mai_wire_test",
        ...(method === "POST" ? { operationKey: `${key.slice(1)}x` } : {}),
        body,
      });
    }
  });

  it("returns actionable admission refusals and rejects forged or invalid arguments before REST", async () => {
    const request = {
      taskId: "unqualified-task",
      expectedTaskRevision: 0,
      expectedSettingsToken: "settings",
      operationKey: "request-1",
    };
    const result = await client.callTool({
      name: "task_launch",
      arguments: request,
    });

    expect(result).toMatchObject({
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify({
            code: "PRECONDITION",
            message: "Qualification is required",
            details: {
              reason: "qualification_missing",
              nextAction: "send_to_triage",
            },
          }),
        },
      ],
    });
    const count = requests.length;

    for (const args of [
      { ...request, mode: "manual" },
      { ...request, actorUserId: "human" },
      { ...request, operationKey: "" },
      { ...request, operationKey: "x".repeat(257) },
      { ...request, expectedTaskRevision: Number.MAX_SAFE_INTEGER + 1 },
      { ...request, baseCommit: "main" },
      {
        ...request,
        executionPolicy: {
          preset: "assisted",
          overrides: { budget: { run: { maxTokens: 0 } } },
        },
      },
      { ...request, packageVersions: { "": "keep" } },
      { ...request, packageVersions: { ["x".repeat(257)]: "keep" } },
      {
        ...request,
        packageVersions: Object.fromEntries(
          Array.from({ length: 65 }, (_, index) => [`cut-${index}`, "keep"]),
        ),
      },
      { ...request, packageVersions: { cut: "unsafe" } },
      {
        ...request,
        executionPolicy: {
          preset: "assisted",
          overrides: { skipProtection: true },
        },
      },
    ]) {
      expect(
        (await client.callTool({ name: "task_launch", arguments: args }))
          .isError,
      ).toBe(true);
    }
    expect(
      (
        await client.callTool({
          name: "task_launch_status",
          arguments: { intentId: "" },
        })
      ).isError,
    ).toBe(true);
    expect(
      (
        await client.callTool({
          name: "task_launch_cancel",
          arguments: {
            intentId: "intent-1",
            expectedStateVersion: 0,
            operationKey: "key",
          },
        })
      ).isError,
    ).toBe(true);
    expect(requests).toHaveLength(count);
  });

  it("forwards agent options and exact automatic launch settings while refusing mixed targets", async () => {
    const selection = {
      taskId: "task-1",
      agentId: "core:implementer",
      workspace: "none",
      runnerId: "codex-sol",
    };
    const preview = await client.callTool({
      name: "task_launch_options",
      arguments: selection,
    });

    expect(preview.isError).not.toBe(true);
    expect(requests.at(-1)).toMatchObject({
      method: "GET",
      url: `/api/v1/ext/task-launch-intents/options?${new URLSearchParams(selection)}`,
    });
    const request = {
      ...selection,
      expectedTaskRevision: 3,
      expectedSettingsToken: "settings-agent",
      operationKey: "agent-operation",
    };
    const response = await client.callTool({
      name: "task_launch",
      arguments: request,
    });

    expect(response.isError).not.toBe(true);
    expect(requests.at(-1)).toMatchObject({
      method: "POST",
      url: "/api/v1/ext/task-launch-intents",
      operationKey: "agent-operation",
      body: {
        ...selection,
        expectedTaskRevision: 3,
        expectedSettingsToken: "settings-agent",
      },
    });
    const count = requests.length;

    for (const invalid of [
      { ...request, flowId: "aif-bugfix" },
      {
        taskId: "task-1",
        workspace: "none",
        expectedTaskRevision: 3,
        expectedSettingsToken: "settings",
        operationKey: "invalid",
      },
      { ...request, mode: "manual" },
    ])
      expect(
        (await client.callTool({ name: "task_launch", arguments: invalid }))
          .isError,
      ).toBe(true);
    expect(requests).toHaveLength(count);
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
      await closeClient(unauthenticated);
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
