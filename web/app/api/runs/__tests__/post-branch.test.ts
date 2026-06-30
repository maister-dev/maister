import type { NextRequest } from "next/server";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// M18 Phase 1 — RED. Pins POST /api/runs body-schema + passthrough:
//   - postBodySchema accepts optional baseBranch/targetBranch (z.string().min(1)
//     .optional()); a body carrying them parses (no 400 CONFIG).
//   - the parsed values are forwarded into launchRun.

const mocks = vi.hoisted(() => ({
  launchRun: vi.fn(),
  launchRunStaged: vi.fn(),
  requireActiveSession: vi.fn(),
  requireProjectAction: vi.fn(),
}));

vi.mock("@/lib/services/runs", () => ({
  launchRun: mocks.launchRun,
  launchRunStaged: mocks.launchRunStaged,
}));
vi.mock("@/lib/authz", () => ({
  requireActiveSession: mocks.requireActiveSession,
  requireProjectAction: mocks.requireProjectAction,
}));

let POST: (req: NextRequest) => Promise<Response>;

function request(body: Record<string, unknown>): NextRequest {
  return new Request("http://x/api/runs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as NextRequest;
}

function streamRequest(body: Record<string, unknown>): NextRequest {
  return new Request("http://x/api/runs", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "text/event-stream",
    },
    body: JSON.stringify(body),
  }) as NextRequest;
}

function parseSseFrames(text: string): Array<Record<string, unknown>> {
  return text
    .split("\n\n")
    .map((block) => block.trim())
    .filter((block) => block.startsWith("data:"))
    .map(
      (block) =>
        JSON.parse(block.slice(block.indexOf("data:") + 5).trim()) as Record<
          string,
          unknown
        >,
    );
}

beforeEach(async () => {
  mocks.requireActiveSession.mockResolvedValue({ id: "user-1" });
  mocks.requireProjectAction.mockResolvedValue({ role: "member" });
  mocks.launchRun.mockResolvedValue({ runId: "run-1", status: "Running" });

  ({ POST } = await import("../route"));
});

afterEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

describe("POST /api/runs — branch-targeting body schema (M18)", () => {
  it("accepts optional baseBranch/targetBranch and forwards them to launchRun", async () => {
    const res = await POST(
      request({
        taskId: "task-1",
        baseBranch: "develop",
        targetBranch: "release",
      }),
    );

    expect(res.status).toBe(202);
    expect(mocks.launchRun).toHaveBeenCalledTimes(1);

    const input = mocks.launchRun.mock.calls[0]?.[0] as Record<string, unknown>;

    expect(input).toMatchObject({
      taskId: "task-1",
      baseBranch: "develop",
      targetBranch: "release",
    });
  });

  it("still accepts a minimal body without branch fields (one-click launch path)", async () => {
    const res = await POST(request({ taskId: "task-1" }));

    expect(res.status).toBe(202);
    expect(mocks.launchRun).toHaveBeenCalledTimes(1);

    const input = mocks.launchRun.mock.calls[0]?.[0] as Record<string, unknown>;

    expect(input.baseBranch).toBeUndefined();
    expect(input.targetBranch).toBeUndefined();
  });

  it("rejects an empty-string baseBranch (z.string().min(1)) with 400 CONFIG before launch", async () => {
    const res = await POST(request({ taskId: "task-1", baseBranch: "" }));
    const body = (await res.json()) as { code?: string };

    expect(res.status).toBe(400);
    expect(body.code).toBe("CONFIG");
    expect(mocks.launchRun).not.toHaveBeenCalled();
  });
});

describe("POST /api/runs — ADR-119 allowConcurrent body flag", () => {
  it("parses allowConcurrent:true and forwards it to launchRun", async () => {
    const res = await POST(request({ taskId: "task-1", allowConcurrent: true }));

    expect(res.status).toBe(202);
    expect(mocks.launchRun).toHaveBeenCalledTimes(1);

    const input = mocks.launchRun.mock.calls[0]?.[0] as Record<string, unknown>;

    expect(input.allowConcurrent).toBe(true);
  });

  it("defaults allowConcurrent to false when absent", async () => {
    const res = await POST(request({ taskId: "task-1" }));

    expect(res.status).toBe(202);

    const input = mocks.launchRun.mock.calls[0]?.[0] as Record<string, unknown>;

    expect(input.allowConcurrent).toBe(false);
  });

  it("rejects a non-boolean allowConcurrent with 400 CONFIG before launch", async () => {
    const res = await POST(
      request({ taskId: "task-1", allowConcurrent: "yes" }),
    );
    const body = (await res.json()) as { code?: string };

    expect(res.status).toBe(400);
    expect(body.code).toBe("CONFIG");
    expect(mocks.launchRun).not.toHaveBeenCalled();
  });
});

describe("POST /api/runs — ADR-085 flow and delivery-policy overrides", () => {
  it("accepts flowId and deliveryPolicy and forwards them to launchRun", async () => {
    const deliveryPolicy = {
      strategy: "ai_rebase_merge",
      push: "on_success",
      trigger: "auto_on_ready",
      targetBranch: "release",
    };

    const res = await POST(
      request({
        taskId: "task-1",
        flowId: "flow-2",
        deliveryPolicy,
      }),
    );

    expect(res.status).toBe(202);
    expect(mocks.launchRun).toHaveBeenCalledTimes(1);

    const input = mocks.launchRun.mock.calls[0]?.[0] as Record<string, unknown>;

    expect(input).toMatchObject({
      taskId: "task-1",
      flowId: "flow-2",
      deliveryPolicy,
    });
  });
});

describe("POST /api/runs — T6.3 content-negotiated launch progress", () => {
  it("streams ordered launch-progress frames + a result frame on Accept text/event-stream", async () => {
    mocks.launchRunStaged.mockImplementation(async function* () {
      yield { type: "scratch.launch_progress", stage: "precondition" };
      yield { type: "scratch.launch_progress", stage: "worktree_created" };
      yield {
        type: "scratch.launch_progress",
        stage: "materializing",
        adapter: "codex",
      };

      return { runId: "run-1", status: "Running" };
    });

    const res = await POST(streamRequest({ taskId: "task-1" }));

    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const frames = parseSseFrames(await res.text());

    expect(
      frames
        .filter((f) => f.type === "scratch.launch_progress")
        .map((f) => f.stage),
    ).toEqual(["precondition", "worktree_created", "materializing"]);

    const result = frames.find((f) => f.type === "scratch.launch_result");

    expect(result?.result).toMatchObject({ runId: "run-1", status: "Running" });
    expect(mocks.launchRun).not.toHaveBeenCalled();
  });

  it("keeps a pre-stream precondition failure as a JSON error with its status", async () => {
    // Dynamic import so the MaisterError class matches the route's instance
    // after vi.resetModules() re-imported the route in beforeEach.
    const { MaisterError } = await import("@/lib/errors");

    mocks.launchRunStaged.mockImplementation(async function* () {
      throw new MaisterError("PRECONDITION", "task is not launchable");
    });

    const res = await POST(streamRequest({ taskId: "task-1" }));
    const body = (await res.json()) as { code?: string };

    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.status).toBe(409);
    expect(body.code).toBe("PRECONDITION");
  });

  it("uses the JSON 202 path (not the generator) without the SSE Accept header", async () => {
    const res = await POST(request({ taskId: "task-1" }));

    expect(res.status).toBe(202);
    expect(mocks.launchRun).toHaveBeenCalledTimes(1);
    expect(mocks.launchRunStaged).not.toHaveBeenCalled();
  });
});
