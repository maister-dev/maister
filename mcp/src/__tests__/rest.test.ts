import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";

import { callExt, restResponseToToolError } from "@/rest";

const BASE_URL = "http://localhost:3000";
const AUTH = "Bearer mai_test";

let fetchSpy: MockInstance<typeof fetch>;

function mockOnce(response: Response): void {
  fetchSpy.mockResolvedValueOnce(response);
}

beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, "fetch") as unknown as MockInstance<
    typeof fetch
  >;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("callExt — outbound request shape", () => {
  it("issues a GET to the interpolated URL with the forwarded Authorization", async () => {
    mockOnce(new Response(JSON.stringify({ tasks: [] }), { status: 200 }));

    await callExt({
      baseUrl: BASE_URL,
      authHeader: AUTH,
      method: "GET",
      path: "/api/v1/ext/projects/demo/tasks",
    });

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];

    expect(url).toBe(`${BASE_URL}/api/v1/ext/projects/demo/tasks`);
    expect(init.method).toBe("GET");
    expect((init.headers as Record<string, string>).Authorization).toBe(AUTH);
    expect(init.body).toBeUndefined();
  });

  it("serializes the JSON body and sets a JSON content-type on POST", async () => {
    mockOnce(new Response(JSON.stringify({ taskId: "t1" }), { status: 201 }));

    await callExt({
      baseUrl: BASE_URL,
      authHeader: AUTH,
      method: "POST",
      path: "/api/v1/ext/projects/demo/tasks",
      body: { title: "T", prompt: "P", flowId: "bugfix" },
    });

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;

    expect(init.method).toBe("POST");
    expect(headers.Authorization).toBe(AUTH);
    expect(headers["Content-Type"]).toMatch(/application\/json/);
    expect(JSON.parse(init.body as string)).toEqual({
      title: "T",
      prompt: "P",
      flowId: "bugfix",
    });
  });

  it("forwards the AbortSignal to fetch", async () => {
    mockOnce(new Response(JSON.stringify({ tasks: [] }), { status: 200 }));

    const controller = new AbortController();

    await callExt({
      baseUrl: BASE_URL,
      authHeader: AUTH,
      method: "GET",
      path: "/api/v1/ext/projects/demo/tasks",
      signal: controller.signal,
    });

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];

    expect(init.signal).toBe(controller.signal);
  });
});

describe("restResponseToToolError — faithful upstream surfacing", () => {
  it("preserves a 401 status and upstream code", async () => {
    const res = new Response(
      JSON.stringify({ code: "UNAUTHORIZED", message: "bad token" }),
      { status: 401 },
    );

    const err = await restResponseToToolError(res);

    expect(err.isError).toBe(true);
    expect(err.status).toBe(401);
    expect(err.code).toBe("UNAUTHORIZED");
    expect(err.message).toContain("bad token");
  });

  it("preserves a 404 status and upstream code (existence-hide)", async () => {
    const res = new Response(
      JSON.stringify({ code: "NOT_FOUND", message: "no such task" }),
      { status: 404 },
    );

    const err = await restResponseToToolError(res);

    expect(err.isError).toBe(true);
    expect(err.status).toBe(404);
    expect(err.code).toBe("NOT_FOUND");
  });

  it("preserves a 422 status and upstream code", async () => {
    const res = new Response(
      JSON.stringify({ code: "VALIDATION", message: "flowId not in project" }),
      { status: 422 },
    );

    const err = await restResponseToToolError(res);

    expect(err.isError).toBe(true);
    expect(err.status).toBe(422);
    expect(err.code).toBe("VALIDATION");
  });

  // MEDIUM-1 regression: non-JSON upstream body (e.g. nginx 502 HTML) must not throw
  it("returns fallback error with correct status on non-JSON upstream body", async () => {
    const res = new Response("<html>Bad Gateway</html>", { status: 502 });

    const err = await restResponseToToolError(res);

    expect(err.isError).toBe(true);
    expect(err.status).toBe(502);
    expect(err.code).toBe("UPSTREAM");
  });
});
