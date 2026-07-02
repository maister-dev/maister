import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";

import { dispatchTool, TOOL_SPECS } from "@/tools";

const BASE_URL = "http://localhost:3000";
const AUTH = "Bearer mai_test";

const httpCtx = {
  transport: "http" as const,
  inboundAuthorization: AUTH,
};

let fetchSpy: MockInstance<typeof fetch>;

function mockOnce(body: unknown, status: number): void {
  fetchSpy.mockResolvedValueOnce(
    new Response(JSON.stringify(body), { status }),
  );
}

function lastRequest(): { url: string; init: RequestInit } {
  const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];

  return { url, init };
}

function headerAuth(init: RequestInit): string | undefined {
  return (init.headers as Record<string, string>).Authorization;
}

function parsedBody(init: RequestInit): unknown {
  return init.body === undefined ? undefined : JSON.parse(init.body as string);
}

beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, "fetch") as unknown as MockInstance<
    typeof fetch
  >;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("TOOL_SPECS registry", () => {
  it("registers all 26 external tools (incl. personal HITL inbox + discovery)", () => {
    expect(Object.keys(TOOL_SPECS).sort()).toEqual(
      [
        "comment_create",
        "comment_list",
        "flow_list",
        "gate_report",
        "hitl_inbox",
        "hitl_list",
        "hitl_respond",
        "readiness_get",
        "relation_add",
        "relation_list",
        "relation_remove",
        "run_cancel",
        "run_collect",
        "run_delegate",
        "run_get",
        "run_launch",
        "run_message",
        "run_plan",
        "run_promote",
        "run_rework",
        "runner_list",
        "task_create",
        "task_get",
        "task_list",
        "task_update",
        "triage_set",
      ].sort(),
    );
  });

  it("task_create no longer requires flowId (M34 simple-intent creation)", () => {
    expect(
      (TOOL_SPECS.task_create.inputSchema as { required: string[] }).required,
    ).toEqual(["slug", "title", "prompt"]);
  });

  it("documents that hitl_respond can answer human gates only with exact personal-token scope", () => {
    expect(TOOL_SPECS.hitl_respond.description).toContain("hitl:respond:human");
    expect(TOOL_SPECS.hitl_respond.description).toContain(
      "global personal token",
    );
  });
});

describe("dispatchTool — per-tool outbound request mapping", () => {
  it("task_create → POST /api/v1/ext/projects/{slug}/tasks (strips executorOverrideId — the strict route refuses it)", async () => {
    mockOnce({ taskId: "t1" }, 201);

    await dispatchTool({
      name: "task_create",
      args: {
        slug: "demo",
        title: "Fix bug",
        prompt: "Do the thing",
        flowId: "bugfix",
        executorOverrideId: "exec-1",
      },
      ctx: httpCtx,
      baseUrl: BASE_URL,
    });

    const { url, init } = lastRequest();

    expect(init.method).toBe("POST");
    expect(url).toBe(`${BASE_URL}/api/v1/ext/projects/demo/tasks`);
    expect(headerAuth(init)).toBe(AUTH);
    expect(parsedBody(init)).toEqual({
      title: "Fix bug",
      prompt: "Do the thing",
      flowId: "bugfix",
    });
  });

  it("task_list → GET /api/v1/ext/projects/{slug}/tasks (no body)", async () => {
    mockOnce({ tasks: [] }, 200);

    await dispatchTool({
      name: "task_list",
      args: { slug: "demo" },
      ctx: httpCtx,
      baseUrl: BASE_URL,
    });

    const { url, init } = lastRequest();

    expect(init.method).toBe("GET");
    expect(url).toBe(`${BASE_URL}/api/v1/ext/projects/demo/tasks`);
    expect(headerAuth(init)).toBe(AUTH);
    expect(parsedBody(init)).toBeUndefined();
  });

  it("task_get → GET /api/v1/ext/projects/{slug}/tasks/{taskId}", async () => {
    mockOnce({ id: "task-1" }, 200);

    await dispatchTool({
      name: "task_get",
      args: { slug: "demo", taskId: "task-1" },
      ctx: httpCtx,
      baseUrl: BASE_URL,
    });

    const { url, init } = lastRequest();

    expect(init.method).toBe("GET");
    expect(url).toBe(`${BASE_URL}/api/v1/ext/projects/demo/tasks/task-1`);
    expect(headerAuth(init)).toBe(AUTH);
    expect(parsedBody(init)).toBeUndefined();
  });

  it("flow_list → GET /api/v1/ext/projects/{slug}/flows (no body)", async () => {
    mockOnce({ flows: [] }, 200);

    await dispatchTool({
      name: "flow_list",
      args: { slug: "demo" },
      ctx: httpCtx,
      baseUrl: BASE_URL,
    });

    const { url, init } = lastRequest();

    expect(init.method).toBe("GET");
    expect(url).toBe(`${BASE_URL}/api/v1/ext/projects/demo/flows`);
    expect(headerAuth(init)).toBe(AUTH);
    expect(parsedBody(init)).toBeUndefined();
  });

  it("runner_list → GET /api/v1/ext/projects/{slug}/runners (no body)", async () => {
    mockOnce({ runners: [] }, 200);

    await dispatchTool({
      name: "runner_list",
      args: { slug: "demo" },
      ctx: httpCtx,
      baseUrl: BASE_URL,
    });

    const { url, init } = lastRequest();

    expect(init.method).toBe("GET");
    expect(url).toBe(`${BASE_URL}/api/v1/ext/projects/demo/runners`);
    expect(headerAuth(init)).toBe(AUTH);
    expect(parsedBody(init)).toBeUndefined();
  });

  it("task_update → PATCH /api/v1/ext/projects/{slug}/tasks/{taskId} (strips executorOverrideId — the strict route refuses it)", async () => {
    mockOnce({ id: "task-1" }, 200);

    await dispatchTool({
      name: "task_update",
      args: {
        slug: "demo",
        taskId: "task-1",
        title: "New title",
        prompt: "New prompt",
        executorOverrideId: null,
      },
      ctx: httpCtx,
      baseUrl: BASE_URL,
    });

    const { url, init } = lastRequest();

    expect(init.method).toBe("PATCH");
    expect(url).toBe(`${BASE_URL}/api/v1/ext/projects/demo/tasks/task-1`);
    expect(headerAuth(init)).toBe(AUTH);
    expect(parsedBody(init)).toEqual({
      title: "New title",
      prompt: "New prompt",
    });
  });

  it("run_launch → POST /api/v1/ext/runs", async () => {
    mockOnce({ runId: "run-1", status: "Running" }, 202);

    await dispatchTool({
      name: "run_launch",
      args: { taskId: "task-1", executorOverrideId: "exec-2" },
      ctx: httpCtx,
      baseUrl: BASE_URL,
    });

    const { url, init } = lastRequest();

    expect(init.method).toBe("POST");
    expect(url).toBe(`${BASE_URL}/api/v1/ext/runs`);
    expect(headerAuth(init)).toBe(AUTH);
    expect(parsedBody(init)).toEqual({
      taskId: "task-1",
      executorOverrideId: "exec-2",
    });
  });

  it("run_get → GET /api/v1/ext/runs/{runId}", async () => {
    mockOnce({ id: "run-1" }, 200);

    await dispatchTool({
      name: "run_get",
      args: { runId: "run-1" },
      ctx: httpCtx,
      baseUrl: BASE_URL,
    });

    const { url, init } = lastRequest();

    expect(init.method).toBe("GET");
    expect(url).toBe(`${BASE_URL}/api/v1/ext/runs/run-1`);
    expect(headerAuth(init)).toBe(AUTH);
    expect(parsedBody(init)).toBeUndefined();
  });

  it("run_delegate → POST /api/v1/ext/runs/delegate with only defined keys", async () => {
    mockOnce({ childRunId: "child-1", childTaskId: "task-9" }, 202);

    await dispatchTool({
      name: "run_delegate",
      args: {
        target: { agentId: "pkg:worker" },
        mode: "task",
        prompt: "Do the subtask",
        title: "Subtask",
      },
      ctx: httpCtx,
      baseUrl: BASE_URL,
    });

    const { url, init } = lastRequest();

    expect(init.method).toBe("POST");
    expect(url).toBe(`${BASE_URL}/api/v1/ext/runs/delegate`);
    expect(headerAuth(init)).toBe(AUTH);
    // workspace + runnerOverride omitted (undefined) — only defined keys ride.
    expect(parsedBody(init)).toEqual({
      target: { agentId: "pkg:worker" },
      mode: "task",
      prompt: "Do the subtask",
      title: "Subtask",
    });
  });

  it("run_plan → POST /api/v1/ext/runs/plan forwarding the task DAG", async () => {
    mockOnce({ tasks: [{ key: "a", taskId: "t1", childRunId: "r1" }] }, 202);

    const planTasks = [
      {
        key: "a",
        target: { agentId: "pkg:worker" },
        prompt: "do a",
        dependsOn: [],
      },
      {
        key: "b",
        target: { agentId: "pkg:worker" },
        prompt: "do b",
        dependsOn: ["a"],
      },
    ];

    await dispatchTool({
      name: "run_plan",
      args: { tasks: planTasks },
      ctx: httpCtx,
      baseUrl: BASE_URL,
    });

    const { url, init } = lastRequest();

    expect(init.method).toBe("POST");
    expect(url).toBe(`${BASE_URL}/api/v1/ext/runs/plan`);
    expect(headerAuth(init)).toBe(AUTH);
    expect(parsedBody(init)).toEqual({ tasks: planTasks });
  });

  it("run_collect → POST /api/v1/ext/runs/collect with all:true", async () => {
    mockOnce([], 200);

    await dispatchTool({
      name: "run_collect",
      args: { all: true },
      ctx: httpCtx,
      baseUrl: BASE_URL,
    });

    const { url, init } = lastRequest();

    expect(init.method).toBe("POST");
    expect(url).toBe(`${BASE_URL}/api/v1/ext/runs/collect`);
    expect(headerAuth(init)).toBe(AUTH);
    expect(parsedBody(init)).toEqual({ all: true });
  });

  it("run_cancel → POST /api/v1/ext/runs/cancel", async () => {
    mockOnce({ childRunId: "child-1", status: "Abandoned" }, 200);

    await dispatchTool({
      name: "run_cancel",
      args: { childRunId: "child-1" },
      ctx: httpCtx,
      baseUrl: BASE_URL,
    });

    const { url, init } = lastRequest();

    expect(init.method).toBe("POST");
    expect(url).toBe(`${BASE_URL}/api/v1/ext/runs/cancel`);
    expect(headerAuth(init)).toBe(AUTH);
    expect(parsedBody(init)).toEqual({ childRunId: "child-1" });
  });

  it("run_message → POST /api/v1/ext/runs/message with only defined keys", async () => {
    mockOnce({ childRunId: "child-1", status: "Running" }, 200);

    await dispatchTool({
      name: "run_message",
      args: { addressableKey: "reviewer", prompt: "re-review the diff" },
      ctx: httpCtx,
      baseUrl: BASE_URL,
    });

    const { url, init } = lastRequest();

    expect(init.method).toBe("POST");
    expect(url).toBe(`${BASE_URL}/api/v1/ext/runs/message`);
    expect(headerAuth(init)).toBe(AUTH);
    // childRunId omitted (undefined) — only defined keys ride.
    expect(parsedBody(init)).toEqual({
      addressableKey: "reviewer",
      prompt: "re-review the diff",
    });
  });

  it("run_promote → POST /api/v1/ext/runs/promote", async () => {
    mockOnce({ childRunId: "child-1", status: "Done" }, 200);

    await dispatchTool({
      name: "run_promote",
      args: { childRunId: "child-1" },
      ctx: httpCtx,
      baseUrl: BASE_URL,
    });

    const { url, init } = lastRequest();

    expect(init.method).toBe("POST");
    expect(url).toBe(`${BASE_URL}/api/v1/ext/runs/promote`);
    expect(headerAuth(init)).toBe(AUTH);
    expect(parsedBody(init)).toEqual({ childRunId: "child-1" });
  });

  it("run_rework → POST /api/v1/ext/runs/rework", async () => {
    mockOnce({ childRunId: "child-1", status: "Running" }, 200);

    await dispatchTool({
      name: "run_rework",
      args: { childRunId: "child-1", prompt: "address the review" },
      ctx: httpCtx,
      baseUrl: BASE_URL,
    });

    const { url, init } = lastRequest();

    expect(init.method).toBe("POST");
    expect(url).toBe(`${BASE_URL}/api/v1/ext/runs/rework`);
    expect(headerAuth(init)).toBe(AUTH);
    expect(parsedBody(init)).toEqual({
      childRunId: "child-1",
      prompt: "address the review",
    });
  });

  it("readiness_get → GET /api/v1/ext/runs/{runId}/readiness", async () => {
    mockOnce({ readiness: "ready" }, 200);

    await dispatchTool({
      name: "readiness_get",
      args: { runId: "run-1" },
      ctx: httpCtx,
      baseUrl: BASE_URL,
    });

    const { url, init } = lastRequest();

    expect(init.method).toBe("GET");
    expect(url).toBe(`${BASE_URL}/api/v1/ext/runs/run-1/readiness`);
    expect(headerAuth(init)).toBe(AUTH);
    expect(parsedBody(init)).toBeUndefined();
  });

  it("gate_report → POST /api/v1/ext/runs/{runId}/gates/{gateId}/report", async () => {
    mockOnce({ gateId: "g1", status: "passed", artifactId: "a1" }, 200);

    await dispatchTool({
      name: "gate_report",
      args: {
        runId: "run-1",
        gateId: "g1",
        status: "passed",
        externalRunUrl: "https://ci/run/9",
        commitSha: "abc123",
        summary: "all green",
        payload: { passed: 42 },
      },
      ctx: httpCtx,
      baseUrl: BASE_URL,
    });

    const { url, init } = lastRequest();

    expect(init.method).toBe("POST");
    expect(url).toBe(`${BASE_URL}/api/v1/ext/runs/run-1/gates/g1/report`);
    expect(headerAuth(init)).toBe(AUTH);
    expect(parsedBody(init)).toEqual({
      status: "passed",
      externalRunUrl: "https://ci/run/9",
      commitSha: "abc123",
      summary: "all green",
      payload: { passed: 42 },
    });
  });

  it("hitl_list → GET /api/v1/ext/runs/{runId}/hitl (no body)", async () => {
    mockOnce({ hitl: [] }, 200);

    await dispatchTool({
      name: "hitl_list",
      args: { runId: "run-1" },
      ctx: httpCtx,
      baseUrl: BASE_URL,
    });

    const { url, init } = lastRequest();

    expect(init.method).toBe("GET");
    expect(url).toBe(`${BASE_URL}/api/v1/ext/runs/run-1/hitl`);
    expect(headerAuth(init)).toBe(AUTH);
  });

  it("hitl_inbox → GET /api/v1/ext/hitl (no body)", async () => {
    mockOnce({ hitl: [] }, 200);

    await dispatchTool({
      name: "hitl_inbox",
      args: {},
      ctx: httpCtx,
      baseUrl: BASE_URL,
    });

    const { url, init } = lastRequest();

    expect(init.method).toBe("GET");
    expect(url).toBe(`${BASE_URL}/api/v1/ext/hitl`);
    expect(headerAuth(init)).toBe(AUTH);
    expect(parsedBody(init)).toBeUndefined();
  });

  it("hitl_respond → POST /api/v1/ext/runs/{runId}/hitl/{hitlRequestId}/respond with only defined keys", async () => {
    mockOnce({ ok: true, runStatus: "NeedsInput" }, 200);

    await dispatchTool({
      name: "hitl_respond",
      args: {
        runId: "run-1",
        hitlRequestId: "hitl-1",
        response: { approved: true },
        confidence: 0.8,
      },
      ctx: httpCtx,
      baseUrl: BASE_URL,
    });

    const { url, init } = lastRequest();

    expect(init.method).toBe("POST");
    expect(url).toBe(`${BASE_URL}/api/v1/ext/runs/run-1/hitl/hitl-1/respond`);
    expect(headerAuth(init)).toBe(AUTH);
    // optionId omitted (undefined) — only defined keys are forwarded.
    expect(parsedBody(init)).toEqual({
      response: { approved: true },
      confidence: 0.8,
    });
  });

  it("comment_list → GET /api/v1/ext/projects/{slug}/tasks/{taskId}/comments with paging query", async () => {
    mockOnce({ comments: [] }, 200);

    await dispatchTool({
      name: "comment_list",
      args: { slug: "demo", taskId: "task-1", limit: 5, offset: 10 },
      ctx: httpCtx,
      baseUrl: BASE_URL,
    });

    const { url, init } = lastRequest();

    expect(init.method).toBe("GET");
    expect(url).toBe(
      `${BASE_URL}/api/v1/ext/projects/demo/tasks/task-1/comments?limit=5&offset=10`,
    );
    expect(headerAuth(init)).toBe(AUTH);
  });

  it("comment_list omits the query string when no paging args are given", async () => {
    mockOnce({ comments: [] }, 200);

    await dispatchTool({
      name: "comment_list",
      args: { slug: "demo", taskId: "task-1" },
      ctx: httpCtx,
      baseUrl: BASE_URL,
    });

    const { url } = lastRequest();

    expect(url).toBe(
      `${BASE_URL}/api/v1/ext/projects/demo/tasks/task-1/comments`,
    );
  });

  it("comment_create → POST /api/v1/ext/projects/{slug}/tasks/{taskId}/comments", async () => {
    mockOnce({ comment: { id: "c1" } }, 201);

    await dispatchTool({
      name: "comment_create",
      args: { slug: "demo", taskId: "task-1", body: "see MAI-7" },
      ctx: httpCtx,
      baseUrl: BASE_URL,
    });

    const { url, init } = lastRequest();

    expect(init.method).toBe("POST");
    expect(url).toBe(
      `${BASE_URL}/api/v1/ext/projects/demo/tasks/task-1/comments`,
    );
    expect(headerAuth(init)).toBe(AUTH);
    expect(parsedBody(init)).toEqual({ body: "see MAI-7" });
  });

  it("triage_set → POST /api/v1/ext/projects/{slug}/tasks/{taskId}/triage with only provided fields", async () => {
    mockOnce({ ok: true, triageStatus: "triaged" }, 200);

    await dispatchTool({
      name: "triage_set",
      args: {
        slug: "demo",
        taskId: "task-1",
        flowId: "bugfix",
        promotionMode: "pull_request",
      },
      ctx: httpCtx,
      baseUrl: BASE_URL,
    });

    const { url, init } = lastRequest();

    expect(init.method).toBe("POST");
    expect(url).toBe(
      `${BASE_URL}/api/v1/ext/projects/demo/tasks/task-1/triage`,
    );
    expect(parsedBody(init)).toEqual({
      flowId: "bugfix",
      promotionMode: "pull_request",
    });
  });

  it("triage_set forwards the full verdict surface (baseBranch/enqueue + ADR-121 priority/confidence)", async () => {
    mockOnce({ ok: true, triageStatus: "triaged" }, 200);

    await dispatchTool({
      name: "triage_set",
      args: {
        slug: "demo",
        taskId: "task-1",
        flowId: "bugfix",
        runnerId: "runner-1",
        baseBranch: "main",
        targetBranch: "develop",
        promotionMode: "local_merge",
        enqueue: true,
        priority: "high",
        confidence: 0.9,
      },
      ctx: httpCtx,
      baseUrl: BASE_URL,
    });

    const { init } = lastRequest();

    expect(parsedBody(init)).toEqual({
      flowId: "bugfix",
      runnerId: "runner-1",
      baseBranch: "main",
      targetBranch: "develop",
      promotionMode: "local_merge",
      enqueue: true,
      priority: "high",
      confidence: 0.9,
    });
  });

  it("triage_set forwards a flag-only hold (the dedup/unroutable path)", async () => {
    mockOnce({ ok: true, triageStatus: "flagged" }, 200);

    await dispatchTool({
      name: "triage_set",
      args: { slug: "demo", taskId: "task-1", flag: true, priority: "urgent" },
      ctx: httpCtx,
      baseUrl: BASE_URL,
    });

    const { init } = lastRequest();

    expect(parsedBody(init)).toEqual({ flag: true, priority: "urgent" });
  });

  it("relation_list → GET /api/v1/ext/projects/{slug}/tasks/{taskId}/relations", async () => {
    mockOnce({ relations: [] }, 200);

    await dispatchTool({
      name: "relation_list",
      args: { slug: "demo", taskId: "task-1" },
      ctx: httpCtx,
      baseUrl: BASE_URL,
    });

    const { url, init } = lastRequest();

    expect(init.method).toBe("GET");
    expect(url).toBe(
      `${BASE_URL}/api/v1/ext/projects/demo/tasks/task-1/relations`,
    );
  });

  it("relation_add → POST .../relations with {kind, toNumber}", async () => {
    mockOnce({ ok: true, created: true }, 201);

    await dispatchTool({
      name: "relation_add",
      args: { slug: "demo", taskId: "task-1", kind: "blocks", toNumber: 7 },
      ctx: httpCtx,
      baseUrl: BASE_URL,
    });

    const { url, init } = lastRequest();

    expect(init.method).toBe("POST");
    expect(url).toBe(
      `${BASE_URL}/api/v1/ext/projects/demo/tasks/task-1/relations`,
    );
    expect(parsedBody(init)).toEqual({ kind: "blocks", toNumber: 7 });
  });

  it("relation_remove → DELETE .../relations with {kind, toNumber}", async () => {
    mockOnce({ ok: true, removed: true }, 200);

    await dispatchTool({
      name: "relation_remove",
      args: { slug: "demo", taskId: "task-1", kind: "blocks", toNumber: 7 },
      ctx: httpCtx,
      baseUrl: BASE_URL,
    });

    const { url, init } = lastRequest();

    expect(init.method).toBe("DELETE");
    expect(url).toBe(
      `${BASE_URL}/api/v1/ext/projects/demo/tasks/task-1/relations`,
    );
    expect(parsedBody(init)).toEqual({ kind: "blocks", toNumber: 7 });
  });
});

describe("dispatchTool — ADR-047 transport-auth invariant", () => {
  it("http context with NO inbound bearer → 401-equivalent error, fetch NEVER called", async () => {
    const result = await dispatchTool({
      name: "task_list",
      args: { slug: "demo" },
      ctx: { transport: "http" },
      baseUrl: BASE_URL,
    });

    expect(result.isError).toBe(true);
    expect(result.status).toBe(401);
    expect(fetchSpy).toHaveBeenCalledTimes(0);
  });

  it("http context WITH inbound bearer → fetch called once, exact bearer forwarded", async () => {
    mockOnce({ tasks: [] }, 200);

    await dispatchTool({
      name: "task_list",
      args: { slug: "demo" },
      ctx: { transport: "http", inboundAuthorization: AUTH },
      baseUrl: BASE_URL,
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(headerAuth(lastRequest().init)).toBe(AUTH);
  });

  it("surfaces a faithful upstream error without escalating authority (422 stays 422)", async () => {
    mockOnce({ code: "VALIDATION", message: "flowId not in project" }, 422);

    const result = await dispatchTool({
      name: "task_create",
      args: {
        slug: "demo",
        title: "T",
        prompt: "P",
        flowId: "nope",
      },
      ctx: httpCtx,
      baseUrl: BASE_URL,
    });

    expect(result.isError).toBe(true);
    expect(result.status).toBe(422);
    expect(result.code).toBe("VALIDATION");
  });
});

// HIGH-1 regression: fetch rejection (e.g. ECONNREFUSED) must resolve, not throw
describe("dispatchTool — network failure resilience", () => {
  it("resolves to isError:true when fetch rejects (ECONNREFUSED)", async () => {
    fetchSpy.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const result = await dispatchTool({
      name: "task_list",
      args: { slug: "demo" },
      ctx: httpCtx,
      baseUrl: BASE_URL,
    });

    expect(result.isError).toBe(true);
    expect(result.status).toBeDefined();
    expect(result.code).toBe("NETWORK");
  });
});

// LOW-3 regression: AbortSignal must be threaded through to fetch
describe("dispatchTool — AbortSignal forwarding", () => {
  it("forwards signal to fetch", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ tasks: [] }), { status: 200 }),
    );

    const controller = new AbortController();

    await dispatchTool({
      name: "task_list",
      args: { slug: "demo" },
      ctx: httpCtx,
      baseUrl: BASE_URL,
      signal: controller.signal,
    });

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];

    expect(init.signal).toBe(controller.signal);
  });
});
