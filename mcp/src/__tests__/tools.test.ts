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
  it("registers all 41 external tools (incl. assistant activity pulse + run activity + agent memory)", () => {
    expect(Object.keys(TOOL_SPECS).sort()).toEqual(
      [
        "activity_pulse",
        "agent_memory_write",
        "ask_human",
        "comment_create",
        "comment_list",
        "evaluation_context_get",
        "evaluation_evidence_list",
        "evaluation_evidence_read",
        "evaluation_objective_results",
        "evaluation_result_submit",
        "flow_list",
        "gate_report",
        "hitl_inbox",
        "hitl_list",
        "hitl_respond",
        "memory_recall",
        "memory_clusters",
        "memory_propose",
        "memory_retain",
        "readiness_get",
        "relation_add",
        "relation_list",
        "relation_remove",
        "run_activity",
        "run_cancel",
        "run_collect",
        "run_delegate",
        "run_get",
        "run_launch",
        "run_message",
        "run_plan",
        "run_promote",
        "run_reopen",
        "run_rework",
        "run_sync",
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

  it("mirrors the Brain kind enum for decision/direction retain and recall", () => {
    const recallKinds = (
      TOOL_SPECS.memory_recall.inputSchema.properties as Record<
        string,
        { items?: { enum?: string[] } }
      >
    ).kinds.items?.enum;
    const retainKind = (
      TOOL_SPECS.memory_retain.inputSchema.properties as Record<
        string,
        { enum?: string[] }
      >
    ).kind.enum;

    expect(recallKinds).toEqual([
      "lesson",
      "observation",
      "state_fact",
      "decision",
      "direction",
    ]);
    expect(retainKind).toEqual([
      "lesson",
      "observation",
      "state_fact",
      "decision",
      "direction",
    ]);
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

  it("memory_recall → GET /api/v1/ext/projects/{slug}/memory with repeated kinds + conditional params", async () => {
    mockOnce({ items: [] }, 200);

    await dispatchTool({
      name: "memory_recall",
      args: {
        slug: "demo",
        q: "auth lessons",
        limit: 7,
        kinds: ["lesson", "state_fact"],
        minConfidence: 0.5,
      },
      ctx: httpCtx,
      baseUrl: BASE_URL,
    });

    const { url, init } = lastRequest();

    expect(init.method).toBe("GET");
    // kinds repeat; limit/minConfidence appear only when set.
    expect(url).toBe(
      `${BASE_URL}/api/v1/ext/projects/demo/memory?q=auth+lessons&limit=7&minConfidence=0.5&kinds=lesson&kinds=state_fact`,
    );
    expect(headerAuth(init)).toBe(AUTH);
    expect(parsedBody(init)).toBeUndefined();
  });

  it("memory_recall omits limit/minConfidence/kinds when not provided", async () => {
    mockOnce({ items: [] }, 200);

    await dispatchTool({
      name: "memory_recall",
      args: { slug: "demo", q: "x" },
      ctx: httpCtx,
      baseUrl: BASE_URL,
    });

    const { url } = lastRequest();

    expect(url).toBe(`${BASE_URL}/api/v1/ext/projects/demo/memory?q=x`);
  });

  it("memory_recall preserves indexed-hit pointer fields from the REST response", async () => {
    const payload = {
      items: [
        {
          tier: "indexed",
          chunkId: "chunk-1",
          preview: "indexed preview",
          confidence: 1,
          score: 0.91,
          pointer: {
            sourcePath: "docs/brain.md",
            stableId: "docs/brain.md#section:test",
            sourceRange: { startLine: 1, endLine: 4 },
          },
        },
      ],
    };

    mockOnce(payload, 200);

    const result = await dispatchTool({
      name: "memory_recall",
      args: { slug: "demo", q: "indexed" },
      ctx: httpCtx,
      baseUrl: BASE_URL,
    });

    expect(result).toEqual(payload);
  });

  it("memory_retain → POST /api/v1/ext/projects/{slug}/memory with only-defined body keys", async () => {
    mockOnce({ reinforced: false, item: { id: "i1" } }, 200);

    await dispatchTool({
      name: "memory_retain",
      args: {
        slug: "demo",
        content: "use pnpm, never npm",
        kind: "state_fact",
        tags: ["tooling"],
      },
      ctx: httpCtx,
      baseUrl: BASE_URL,
    });

    const { url, init } = lastRequest();

    expect(init.method).toBe("POST");
    expect(url).toBe(`${BASE_URL}/api/v1/ext/projects/demo/memory`);
    expect(headerAuth(init)).toBe(AUTH);
    // `title` absent → key absent (not null); slug rides the path, never the body.
    expect(parsedBody(init)).toEqual({
      content: "use pnpm, never npm",
      kind: "state_fact",
      tags: ["tooling"],
    });
  });

  it("memory_clusters → GET /api/v1/ext/projects/{slug}/memory/clusters with filters", async () => {
    mockOnce({ clusters: [] }, 200);

    await dispatchTool({
      name: "memory_clusters",
      args: {
        slug: "demo",
        kinds: ["lesson"],
        minRecurrence: 3,
        limit: 5,
      },
      ctx: httpCtx,
      baseUrl: BASE_URL,
    });

    const { url, init } = lastRequest();

    expect(init.method).toBe("GET");
    expect(url).toBe(
      `${BASE_URL}/api/v1/ext/projects/demo/memory/clusters?kinds=lesson&minRecurrence=3&limit=5`,
    );
    expect(headerAuth(init)).toBe(AUTH);
    expect(parsedBody(init)).toBeUndefined();
  });

  it("memory_propose → POST /api/v1/ext/projects/{slug}/memory/proposals", async () => {
    mockOnce({ proposalId: "p1", status: "pending", idempotent: false }, 201);

    await dispatchTool({
      name: "memory_propose",
      args: {
        slug: "demo",
        kind: "rule",
        evidenceItemIds: ["e1"],
        draft: { title: "Rule draft" },
        blastRadius: "low",
        clusterHash: "cluster-1",
        rationale: "recurs",
      },
      ctx: httpCtx,
      baseUrl: BASE_URL,
    });

    const { url, init } = lastRequest();

    expect(init.method).toBe("POST");
    expect(url).toBe(`${BASE_URL}/api/v1/ext/projects/demo/memory/proposals`);
    expect(headerAuth(init)).toBe(AUTH);
    expect(parsedBody(init)).toEqual({
      kind: "rule",
      evidenceItemIds: ["e1"],
      draft: { title: "Rule draft" },
      blastRadius: "low",
      clusterHash: "cluster-1",
      rationale: "recurs",
    });
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

  it("ask_human → POST task-bound endpoint and omits an unspecified re-trigger mode", async () => {
    mockOnce({ hitlRequestId: "h1", activationState: "active" }, 201);
    const schema = {
      schemaVersion: 1,
      fields: [
        {
          name: "target",
          type: "enum",
          required: true,
          options: ["staging", "production"],
        },
      ],
    };

    await dispatchTool({
      name: "ask_human",
      args: {
        slug: "demo",
        taskId: "task-1",
        question: "Which deployment target should be used?",
        schema,
      },
      ctx: httpCtx,
      baseUrl: BASE_URL,
    });

    const { url, init } = lastRequest();

    expect(init.method).toBe("POST");
    expect(url).toBe(
      `${BASE_URL}/api/v1/ext/projects/demo/tasks/task-1/human-asks`,
    );
    expect(headerAuth(init)).toBe(AUTH);
    expect(parsedBody(init)).toEqual({
      question: "Which deployment target should be used?",
      schema,
    });
  });

  it("run_launch → POST /api/v1/ext/runs forwards the full canonical launch surface (runnerId/baseBranch/targetBranch)", async () => {
    mockOnce({ runId: "run-1", status: "Running" }, 202);

    await dispatchTool({
      name: "run_launch",
      args: {
        taskId: "task-1",
        runnerId: "claude-code",
        baseBranch: "main",
        targetBranch: "develop",
      },
      ctx: httpCtx,
      baseUrl: BASE_URL,
    });

    const { url, init } = lastRequest();

    expect(init.method).toBe("POST");
    expect(url).toBe(`${BASE_URL}/api/v1/ext/runs`);
    expect(headerAuth(init)).toBe(AUTH);
    expect(parsedBody(init)).toEqual({
      taskId: "task-1",
      runnerId: "claude-code",
      baseBranch: "main",
      targetBranch: "develop",
    });
  });

  it("run_launch still forwards the deprecated executorOverrideId alias (back-compat)", async () => {
    mockOnce({ runId: "run-1", status: "Running" }, 202);

    await dispatchTool({
      name: "run_launch",
      args: { taskId: "task-1", executorOverrideId: "exec-2" },
      ctx: httpCtx,
      baseUrl: BASE_URL,
    });

    // Only defined keys ride — runnerId/baseBranch/targetBranch omitted.
    expect(parsedBody(lastRequest().init)).toEqual({
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

  it("activity_pulse → GET /api/v1/ext/activity with query args only", async () => {
    mockOnce({ happened: { items: [] }, now: { runs: [] }, needsYou: { items: [] } }, 200);

    await dispatchTool({
      name: "activity_pulse",
      args: { since: "12", salience: "normal" },
      ctx: httpCtx,
      baseUrl: BASE_URL,
    });

    const { url, init } = lastRequest();

    expect(init.method).toBe("GET");
    expect(url).toBe(`${BASE_URL}/api/v1/ext/activity?since=12&salience=normal`);
    expect(headerAuth(init)).toBe(AUTH);
    expect(parsedBody(init)).toBeUndefined();
  });

  it("run_activity → GET /api/v1/ext/runs/{runId}/activity with cursor, limit, and salience", async () => {
    mockOnce({ items: [], nextSinceId: "0", hasMore: false, now: null }, 200);

    await dispatchTool({
      name: "run_activity",
      args: {
        runId: "run-1",
        sinceId: "4",
        limit: 25,
        salience: "high",
      },
      ctx: httpCtx,
      baseUrl: BASE_URL,
    });

    const { url, init } = lastRequest();

    expect(init.method).toBe("GET");
    expect(url).toBe(
      `${BASE_URL}/api/v1/ext/runs/run-1/activity?sinceId=4&limit=25&salience=high`,
    );
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

  it("triage_set forwards null priority/confidence (the explicit clear path — null is not dropped)", async () => {
    mockOnce({ ok: true }, 200);

    await dispatchTool({
      name: "triage_set",
      args: {
        slug: "demo",
        taskId: "task-1",
        priority: null,
        confidence: null,
      },
      ctx: httpCtx,
      baseUrl: BASE_URL,
    });

    // null ≠ undefined, so the clear intent reaches the route (priority →
    // 'normal', confidence → NULL) instead of being silently dropped.
    expect(parsedBody(lastRequest().init)).toEqual({
      priority: null,
      confidence: null,
    });
  });

  // The description is the ONLY signal the agent gets that a ref is accepted —
  // main.ts registers a passthrough z.record, so the per-field inputSchema is
  // never advertised. Losing this text silently strands agents on UUIDs.
  it("advertises ref-or-UUID flowId on triage_set and task_create, and on no other tool", async () => {
    for (const tool of ["triage_set", "task_create"]) {
      // Exact phrase, not a loose "ref" substring ("reference"/"prefer" would
      // satisfy that while saying nothing about the ref namespace).
      expect(TOOL_SPECS[tool].description).toContain(
        "accepts either the flow's UUID or its ref",
      );
      expect(TOOL_SPECS[tool].description).toContain("flow_list");
    }

    // The scope fence: delegate's target.flowId is a Phase-3 stub and
    // run_launch has no flowId param (the ext runs route refuses one per
    // ADR-085) — neither may start advertising ref acceptance.
    for (const tool of ["run_launch", "run_delegate"]) {
      expect(TOOL_SPECS[tool].description).not.toContain("or its ref");
    }
  });

  it("triage_set coerces a stringified numeric confidence to a number (an LLM emits 0.8 as a string; the strict ext route needs a number)", async () => {
    mockOnce({ ok: true, triageStatus: "triaged" }, 200);

    await dispatchTool({
      name: "triage_set",
      args: {
        slug: "demo",
        taskId: "task-1",
        flowId: "bugfix",
        runnerId: "runner-1",
        baseBranch: "main",
        confidence: "0.8",
      },
      ctx: httpCtx,
      baseUrl: BASE_URL,
    });

    // The MCP seam normalizes numeric args to their declared inputSchema type,
    // so the string never reaches the ext route's strict z.number() gate.
    expect(parsedBody(lastRequest().init)).toEqual({
      flowId: "bugfix",
      runnerId: "runner-1",
      baseBranch: "main",
      confidence: 0.8,
    });
  });

  it("triage_set leaves a non-numeric confidence string untouched (genuine bad input surfaces at the route, is not silently zeroed)", async () => {
    mockOnce({ ok: true }, 200);

    await dispatchTool({
      name: "triage_set",
      args: { slug: "demo", taskId: "task-1", confidence: "high" },
      ctx: httpCtx,
      baseUrl: BASE_URL,
    });

    // "high" is not a finite number → forwarded verbatim so the ext route
    // returns a clear invalid_type error, rather than the seam turning it into
    // NaN/0 and hiding the mistake.
    expect(parsedBody(lastRequest().init)).toEqual({ confidence: "high" });
  });

  it("relation_add coerces a stringified integer toNumber (the numeric normalization spans integer fields, not just confidence)", async () => {
    mockOnce({ ok: true }, 200);

    await dispatchTool({
      name: "relation_add",
      args: {
        slug: "demo",
        taskId: "task-1",
        kind: "depends_on",
        toNumber: "5",
      },
      ctx: httpCtx,
      baseUrl: BASE_URL,
    });

    expect(parsedBody(lastRequest().init)).toEqual({
      kind: "depends_on",
      toNumber: 5,
    });
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

  // ADR-155: dispatchTool destructures known keys, so a schema-only change
  // ships a facade that ACCEPTS toTaskKey and silently never sends it.
  it("relation_add FORWARDS toTaskKey and omits toNumber entirely", async () => {
    mockOnce({ ok: true, created: true }, 201);

    await dispatchTool({
      name: "relation_add",
      args: {
        slug: "demo",
        taskId: "task-1",
        kind: "depends_on",
        toTaskKey: "API-42",
      },
      ctx: httpCtx,
      baseUrl: BASE_URL,
    });

    expect(parsedBody(lastRequest().init)).toEqual({
      kind: "depends_on",
      toTaskKey: "API-42",
    });
  });

  it("relation_remove FORWARDS a requires edge addressed by toTaskKey", async () => {
    mockOnce({ ok: true, removed: true }, 200);

    await dispatchTool({
      name: "relation_remove",
      args: {
        slug: "demo",
        taskId: "task-1",
        kind: "requires",
        toTaskKey: "API-42",
      },
      ctx: httpCtx,
      baseUrl: BASE_URL,
    });

    const { init } = lastRequest();

    expect(init.method).toBe("DELETE");
    expect(parsedBody(init)).toEqual({
      kind: "requires",
      toTaskKey: "API-42",
    });
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
