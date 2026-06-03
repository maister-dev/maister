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
  it("registers all 8 external tools", () => {
    expect(Object.keys(TOOL_SPECS).sort()).toEqual(
      [
        "gate_report",
        "readiness_get",
        "run_get",
        "run_launch",
        "task_create",
        "task_get",
        "task_list",
        "task_update",
      ].sort(),
    );
  });
});

describe("dispatchTool — per-tool outbound request mapping", () => {
  it("task_create → POST /api/v1/ext/projects/{slug}/tasks", async () => {
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
      executorOverrideId: "exec-1",
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

  it("task_update → PATCH /api/v1/ext/projects/{slug}/tasks/{taskId}", async () => {
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
      executorOverrideId: null,
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
