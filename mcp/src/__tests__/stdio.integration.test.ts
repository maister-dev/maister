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

  async function connectClient(
    identity: Readonly<{
      token: string;
      toolset?: string;
      installationScopes?: readonly string[];
    }>,
  ): Promise<Client> {
    const connected = await connectCompiledMcp({ baseUrl, ...identity });

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
    client = await connectClient({ token: "mai_wire_test" });
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
      tools.map(({ name, description, inputSchema, annotations }) => ({
        name,
        description,
        inputSchema,
        ...(annotations ? { annotations } : {}),
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

  it("inspects appointed assignment revisions through the built company facade and refuses forged selectors locally", async () => {
    const company = await connectClient({
      token: "mai_assignment_wire",
      toolset: "company",
    });

    try {
      const listed = await company.listTools();

      expect(
        listed.tools.find((tool) => tool.name === "assignment_get")?.annotations
          ?.readOnlyHint,
      ).toBe(true);
      const result = await company.callTool({
        name: "assignment_get",
        arguments: { assignmentId: "assignment / exact" },
      });

      expect(result.isError).not.toBe(true);
      expect(requests.at(-1)).toEqual({
        method: "GET",
        url: "/api/v1/ext/specialist-assignments/assignment%20%2F%20exact",
        authorization: "Bearer mai_assignment_wire",
        body: {},
      });
      const before = requests.length;

      for (const arguments_ of [
        { assignmentId: "assignment", actor: { kind: "user", id: "forged" } },
        { assignmentId: "" },
        { assignmentId: "assignment", revision: 1 },
      ]) {
        const refused = await company.callTool({
          name: "assignment_get",
          arguments: arguments_,
        });

        expect(refused.isError).toBe(true);
      }
      expect(requests).toHaveLength(before);
    } finally {
      await closeClient(company);
    }
  });

  it("forwards exact delegated work, collection, clarification and rework through the built company facade", async () => {
    const company = await connectClient({
      token: "mai_company_delegation_wire",
      toolset: "company",
    });
    const body = {
      target: { agentId: "rah:diagnostic" },
      mode: "run",
      prompt: "Inspect the retained observation",
      assignmentWork: {
        selector: {
          schemaVersion: 1,
          assignmentId: "assignment",
          expectedRevision: 3,
          inputRevision: 1,
          contextRevision: 0,
          logicalWorkId: "inspect",
          workRevision: 1,
        },
        expectedOutcome: "A typed diagnosis",
      },
    };
    const child = { childRunId: "56c46e8e-277f-4b49-8f99-ae3e133371ac" };
    const clarification = {
      ...child,
      requestKey: "clarify-observation",
      mode: "steer",
      prompt: "Check if the observation still applies.",
    };
    const rework = {
      ...child,
      prompt: "Recheck the conclusion.",
      assignmentWork: {
        schemaVersion: 1,
        expectedRevision: 2,
        workRevision: 1,
        inputRevision: 1,
        resultRevision: 1,
        requestKey: "recheck-conclusion",
      },
    };

    try {
      for (const [name, path, input] of [
        ["run_delegate", "/api/v1/ext/runs/delegate", body],
        ["run_collect", "/api/v1/ext/runs/collect", child],
        ["run_message", "/api/v1/ext/runs/message", clarification],
        ["run_rework", "/api/v1/ext/runs/rework", rework],
      ] as const) {
        expect(
          (await company.callTool({ name, arguments: input })).isError,
        ).not.toBe(true);
        expect(requests.at(-1)).toEqual({
          method: "POST",
          url: path,
          authorization: "Bearer mai_company_delegation_wire",
          body: input,
        });
      }
      const acceptance = {
        decision: "accept",
        expectedRevision: 2,
        workRevision: 1,
        inputRevision: 1,
        resultRevision: 1,
        reason: "The child supplied the requested result.",
        idempotencyKey: "accept-observation",
      };

      expect(
        (
          await company.callTool({
            name: "specialist_assignment_work_decide",
            arguments: {
              assignmentId: "assignment",
              workId: "work",
              ...acceptance,
            },
          })
        ).isError,
      ).not.toBe(true);
      expect(requests.at(-1)).toEqual({
        method: "POST",
        url: "/api/v1/ext/specialist-assignments/assignment/work/work/decisions",
        authorization: "Bearer mai_company_delegation_wire",
        body: acceptance,
      });
    } finally {
      await closeClient(company);
    }
  });

  it("serves native assignment questions through the built facade with exact HTTP forwarding and human answers outside the company toolset", async () => {
    const company = await connectClient({
      token: "mai_question_wire",
      toolset: "company",
    });
    const body = {
      expectedRevision: 4,
      inputRevision: 1,
      question: "Which configured component?",
      schema: {
        schemaVersion: 1,
        fields: [
          { name: "component", type: "string", required: true },
          {
            name: "observations",
            type: "array",
            items: {
              type: "object",
              fields: [{ name: "healthy", type: "boolean" }],
            },
          },
        ],
      },
      idempotencyKey: "question-wire-1",
    };

    try {
      const listed = await company.listTools();

      expect(
        listed.tools.find((tool) => tool.name === "assignment_question_ask")
          ?.annotations?.readOnlyHint,
      ).toBe(false);
      expect(
        listed.tools.some(
          (tool) => tool.name === "assignment_question_respond",
        ),
      ).toBe(false);
      const asked = await company.callTool({
        name: "assignment_question_ask",
        arguments: { assignmentId: "assignment / exact", ...body },
      });

      expect(asked.isError).not.toBe(true);
      expect(requests.at(-1)).toEqual({
        method: "POST",
        url: "/api/v1/ext/specialist-assignments/assignment%20%2F%20exact/questions",
        authorization: "Bearer mai_question_wire",
        body: { ...body, reTriggerMode: "agent" },
      });
      const before = requests.length;

      for (const arguments_ of [
        {
          assignmentId: "assignment",
          ...body,
          actor: { kind: "user", id: "forged" },
        },
        { assignmentId: "assignment", ...body, inputRevision: 0 },
        {
          assignmentId: "assignment",
          ...body,
          schema: { ...body.schema, schemaVersion: 2 },
        },
        { assignmentId: "assignment", ...body, reTriggerMode: "triage" },
      ])
        expect(
          (
            await company.callTool({
              name: "assignment_question_ask",
              arguments: arguments_,
            })
          ).isError,
        ).toBe(true);
      expect(
        (
          await company.callTool({
            name: "assignment_question_respond",
            arguments: {
              assignmentId: "assignment",
              questionId: "question",
              expectedRevision: 5,
              inputRevision: 1,
              response: { component: "web" },
              idempotencyKey: "answer-wire-1",
            },
          })
        ).isError,
      ).toBe(true);
      expect(requests).toHaveLength(before);
      const response = {
        expectedRevision: 5,
        inputRevision: 1,
        response: { component: "web" },
        idempotencyKey: "answer-wire-1",
      };

      expect(
        (
          await client.callTool({
            name: "assignment_question_respond",
            arguments: {
              assignmentId: "assignment / exact",
              questionId: "question / exact",
              ...response,
            },
          })
        ).isError,
      ).not.toBe(true);
      expect(requests.at(-1)).toEqual({
        method: "POST",
        url: "/api/v1/ext/specialist-assignments/assignment%20%2F%20exact/questions/question%20%2F%20exact/respond",
        authorization: "Bearer mai_wire_test",
        body: response,
      });
    } finally {
      await company.close();
    }
  });

  it("serves assignment context through the real company facade with exact selectors and local closed-schema refusal", async () => {
    const company = await connectClient({
      token: "mai_context_wire",
      toolset: "company",
    });

    try {
      const listed = await company.listTools();
      const context = listed.tools.find(
        (tool) => tool.name === "assignment_context_get",
      );

      expect(context?.annotations?.readOnlyHint).toBe(true);
      const result = await company.callTool({
        name: "assignment_context_get",
        arguments: { assignmentId: "assignment / exact", revision: 0 },
      });

      expect(result.isError).not.toBe(true);
      expect(requests.at(-1)).toEqual({
        method: "GET",
        url: "/api/v1/ext/specialist-assignments/assignment%20%2F%20exact/context?revision=0",
        authorization: "Bearer mai_context_wire",
        body: {},
      });
      const before = requests.length;

      for (const arguments_ of [
        { assignmentId: "assignment", revision: -1 },
        { assignmentId: "assignment", actor: { kind: "user", id: "forged" } },
        { assignmentId: "assignment", revision: "0" },
      ]) {
        const refused = await company.callTool({
          name: "assignment_context_get",
          arguments: arguments_,
        });

        expect(refused.isError).toBe(true);
      }
      expect(requests).toHaveLength(before);
    } finally {
      await closeClient(company);
    }
  });

  it("sends exact revisioned context edits through the built company facade without accepting authority fields", async () => {
    const company = await connectClient({
      token: "mai_context_write",
      toolset: "company",
    });

    try {
      const listed = await company.listTools();

      expect(
        listed.tools.find((tool) => tool.name === "assignment_context_update")
          ?.annotations?.readOnlyHint,
      ).toBe(false);
      const input = {
        assignmentId: "assignment/exact",
        expectedRevision: 0,
        expectedInputRevision: 1,
        idempotencyKey: "context-wire-write",
        updates: [
          {
            id: "open-question",
            kind: "question",
            text: "Which independent check is missing?",
            state: "open",
            references: [],
          },
        ],
      };
      const result = await company.callTool({
        name: "assignment_context_update",
        arguments: input,
      });

      expect(result.isError).not.toBe(true);
      const body = {
        expectedRevision: input.expectedRevision,
        expectedInputRevision: input.expectedInputRevision,
        idempotencyKey: input.idempotencyKey,
        updates: input.updates,
      };

      expect(requests.at(-1)).toEqual({
        method: "PATCH",
        url: "/api/v1/ext/specialist-assignments/assignment%2Fexact/context",
        authorization: "Bearer mai_context_write",
        body,
      });
      const before = requests.length;
      const refused = await company.callTool({
        name: "assignment_context_update",
        arguments: { ...input, ownerEpoch: 1 },
      });

      expect(refused.isError).toBe(true);
      expect(requests).toHaveLength(before);
    } finally {
      await company.close();
    }
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
    const unauthenticated = await connectClient({ token: "" });
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

  it("the bundled company facade lists the native knowledge and governed work tools and refuses unrelated operations before REST", async () => {
    const company = await connectClient({
      token: "mai_company_wire",
      toolset: "company",
    });

    try {
      const { tools } = await company.listTools();

      expect(tools.map((tool) => tool.name).sort()).toEqual(
        [
          "knowledge_search",
          "knowledge_get",
          "knowledge_evidence",
          "knowledge_conflicts",
          "knowledge_witness_get",
          "knowledge_proposal_get",
          "knowledge_capture_source",
          "knowledge_propose",
          "assignment_get",
          "assignment_context_get",
          "assignment_context_update",
          "assignment_question_ask",
          "stand_operation_create",
          "stand_operation_get",
          "stand_operation_logs",
          "stand_operation_observe",
          "stand_operation_dispatch",
          "stand_operation_verify",
          "run_delegate",
          "run_collect",
          "run_message",
          "run_rework",
          "specialist_assignment_work_decide",
        ].sort(),
      );
      const inspected = await company.callTool({
        name: "knowledge_get",
        arguments: { recordId: "record-1", revision: 1 },
      });

      expect(inspected.isError).not.toBe(true);
      expect(requests.at(-1)).toMatchObject({
        method: "GET",
        url: "/api/v1/ext/knowledge/record-1?revision=1",
        authorization: "Bearer mai_company_wire",
      });
      const intent = {
        expectedRevision: 2,
        inputRevision: 1,
        componentId: "api",
        action: "restart",
        idempotencyKey: "fixture-restart",
      };
      const retained = await company.callTool({
        name: "stand_operation_create",
        arguments: { assignmentId: "assignment-1", ...intent },
      });

      expect(retained.isError).not.toBe(true);
      expect(requests.at(-1)).toMatchObject({
        method: "POST",
        url: "/api/v1/ext/specialist-assignments/assignment-1/operations",
        authorization: "Bearer mai_company_wire",
        body: intent,
      });
      const count = requests.length;

      for (const name of [
        "knowledge_confirm",
        "knowledge_decide",
        "knowledge_proposals_list",
        "librarian_memory_remember",
        "agent_memory_write",
        "run_promote",
      ]) {
        const refused = await company.callTool({ name, arguments: {} });

        expect(refused.isError).toBe(true);
      }
      expect(requests).toHaveLength(count);
    } finally {
      await company.close();
    }
  });

  it("rejects an unknown tool before reaching REST", async () => {
    const count = requests.length;
    const result = await client.callTool({ name: "unknown_tool" });

    expect(result.isError).toBe(true);
    expect(requests).toHaveLength(count);
  });

  it("publishes and forwards installation paging using the opaque cursor", async () => {
    const installation = await connectClient({
      token: "mai_installation_wire",
      toolset: "installation",
      installationScopes: ["projects:read", "tasks:read", "activity:read"],
    });

    try {
      const { tools } = await installation.listTools();
      const pages = [
        { name: "project_list", selector: {}, path: "/api/v1/ext/projects" },
        {
          name: "task_list",
          selector: { slug: "work" },
          path: "/api/v1/ext/projects/work/tasks",
        },
        {
          name: "run_activity",
          selector: { runId: "run-1" },
          path: "/api/v1/ext/runs/run-1/activity",
        },
      ] as const;
      const cursor = "next+page/2=";

      for (const { name, selector, path } of pages) {
        const schema = tools.find((tool) => tool.name === name)?.inputSchema;

        expect(schema?.properties).toMatchObject({
          cursor: { type: "string" },
          limit: { maximum: 50 },
        });
        const result = await installation.callTool({
          name,
          arguments: { ...selector, cursor, limit: 2 },
        });

        expect(result.isError).not.toBe(true);
        const request = requests.at(-1);
        const url = new URL(request?.url ?? "", baseUrl);

        expect(request).toMatchObject({
          method: "GET",
          authorization: "Bearer mai_installation_wire",
        });
        expect(url.pathname).toBe(path);
        expect(Object.fromEntries(url.searchParams)).toEqual({
          cursor,
          limit: "2",
        });
      }
      const count = requests.length;
      const refused = await installation.callTool({
        name: "run_activity",
        arguments: { runId: "run-1", sinceId: "5" },
      });

      expect(refused.isError).toBe(true);
      expect(requests).toHaveLength(count);
      const ordinarySchema = (await client.listTools()).tools.find(
        (tool) => tool.name === "run_activity",
      )?.inputSchema;

      expect(ordinarySchema?.properties).toHaveProperty("sinceId");
      expect(ordinarySchema?.properties).not.toHaveProperty("cursor");
    } finally {
      await closeClient(installation);
    }
  });

  it("AV-15 exposes the vault tool and forwards only closed self-vault commands", async () => {
    const listed = await client.listTools();
    const vault = listed.tools.find(({ name }) => name === "memory");

    expect(vault?.inputSchema.oneOf).toHaveLength(8);
    const wanted = { command: "view", path: "/memories/index.md" };

    await client.callTool({ name: "memory", arguments: wanted });
    expect(requests.at(-1)).toMatchObject({
      method: "POST",
      url: "/api/v1/ext/agent/memory/commands",
      body: wanted,
    });
    const count = requests.length;
    const refused = await client.callTool({
      name: "memory",
      arguments: { ...wanted, agentId: "another:agent" },
    });

    expect(refused.isError).toBe(true);
    expect(requests).toHaveLength(count);
  });
});
