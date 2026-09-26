import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";

import { dispatchTool, isToolInToolset, toolNamesForToolset } from "@/tools";

// ADR-184 (T1.6): the librarian's discovery/read tools, the operation key a
// librarian sends as `Idempotency-Key`, and the `librarian` toolset listing.

const BASE_URL = "http://localhost:3000";
const ctx = {
  transport: "http" as const,
  inboundAuthorization: "Bearer mai_x",
};

let fetchSpy: MockInstance<typeof fetch>;

beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, "fetch") as unknown as MockInstance<
    typeof fetch
  >;
  fetchSpy.mockImplementation(
    async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

function call(): { url: string; init: RequestInit } {
  const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];

  return { url, init };
}

describe("CT-LAU-06 librarian discovery tools route to the visibility-scoped ext reads", () => {
  it.each([
    ["project_list", {}, "GET", "/api/v1/ext/projects"],
    [
      "project_get",
      { slug: "alpha" },
      "GET",
      "/api/v1/ext/projects/alpha/directory",
    ],
    [
      "task_search",
      { q: "invoice pay", cursor: "c1" },
      "GET",
      "/api/v1/ext/tasks/search?q=invoice+pay&cursor=c1",
    ],
    ["work_list", {}, "GET", "/api/v1/ext/work"],
    ["decisions_list", {}, "GET", "/api/v1/ext/decisions"],
    [
      "clarification_list",
      { slug: "alpha", taskId: "task-1" },
      "GET",
      "/api/v1/ext/projects/alpha/tasks/task-1/clarifications",
    ],
    [
      "project_members_list",
      { slug: "alpha" },
      "GET",
      "/api/v1/ext/projects/alpha/members",
    ],
    [
      "activity_feed",
      { projectId: "p1", kind: "created", limit: 20 },
      "GET",
      "/api/v1/ext/activity/feed?projectId=p1&kind=created&limit=20",
    ],
  ])("%s → %s %s", async (name, args, method, path) => {
    await dispatchTool({ name, args, ctx, baseUrl: BASE_URL });

    const { url, init } = call();

    expect(init.method).toBe(method);
    expect(url).toBe(`${BASE_URL}${path}`);
  });

  it("forwards operationKey as the Idempotency-Key header and never in the body", async () => {
    await dispatchTool({
      name: "task_create",
      args: {
        slug: "alpha",
        title: "T",
        prompt: "P",
        operationKey: "turn-1:create:1",
      },
      ctx,
      baseUrl: BASE_URL,
    });

    const { init } = call();
    const headers = init.headers as Record<string, string>;

    expect(headers["Idempotency-Key"]).toBe("turn-1:create:1");
    expect(JSON.parse(init.body as string)).toEqual({
      title: "T",
      prompt: "P",
    });
  });

  it("sends no Idempotency-Key when no operationKey is given", async () => {
    await dispatchTool({
      name: "task_create",
      args: { slug: "alpha", title: "T", prompt: "P" },
      ctx,
      baseUrl: BASE_URL,
    });

    const headers = call().init.headers as Record<string, string>;

    expect(headers).not.toHaveProperty("Idempotency-Key");
  });

  it("routes clarification requests and cancellations with operation keys", async () => {
    await dispatchTool({
      name: "clarification_request",
      args: {
        slug: "alpha",
        taskId: "task-1",
        recipientUserId: "recipient-1",
        question: "Which region?",
        reason: "The target is ambiguous",
        answerFormat: "text",
        blocking: true,
        operationKey: "turn-1:clarification:1",
      },
      ctx,
      baseUrl: BASE_URL,
    });
    expect(call()).toMatchObject({
      url: `${BASE_URL}/api/v1/ext/projects/alpha/tasks/task-1/clarifications`,
      init: { method: "POST" },
    });
    expect(
      (call().init.headers as Record<string, string>)["Idempotency-Key"],
    ).toBe("turn-1:clarification:1");
    expect(JSON.parse(call().init.body as string)).toEqual({
      recipientUserId: "recipient-1",
      question: "Which region?",
      reason: "The target is ambiguous",
      answerFormat: "text",
      blocking: true,
    });

    fetchSpy.mockClear();
    await dispatchTool({
      name: "clarification_cancel",
      args: {
        slug: "alpha",
        taskId: "task-1",
        clarificationId: "clarification-1",
        operationKey: "turn-1:cancel:1",
      },
      ctx,
      baseUrl: BASE_URL,
    });
    expect(call()).toMatchObject({
      url: `${BASE_URL}/api/v1/ext/projects/alpha/tasks/task-1/clarifications/clarification-1`,
      init: { method: "DELETE" },
    });
    expect(
      (call().init.headers as Record<string, string>)["Idempotency-Key"],
    ).toBe("turn-1:cancel:1");
  });
});

describe("CT-LAU-06 the librarian toolset lists only librarian-permitted tools", () => {
  it("offers discovery and work-cycle tools but no human-only or coordinator tool", () => {
    const names = toolNamesForToolset("librarian");

    for (const offered of [
      "task_search",
      "task_create",
      "run_launch",
      "clarification_request",
      "clarification_cancel",
      "clarification_list",
      "project_members_list",
    ]) {
      expect(names).toContain(offered);
    }
    for (const withheld of [
      "hitl_respond",
      "run_promote",
      "run_discard",
      "run_delegate",
      "run_collect",
      "run_cancel",
      "run_rework",
      "triage_set",
      "agent_memory_write",
      "ask_human",
    ]) {
      expect(names).not.toContain(withheld);
      expect(isToolInToolset(withheld, "librarian")).toBe(false);
    }
  });

  it("keeps every registered tool when no toolset is named", () => {
    expect(toolNamesForToolset(undefined)).toContain("hitl_respond");
    expect(isToolInToolset("hitl_respond", undefined)).toBe(true);
  });
});
