import type { NextRequest } from "next/server";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// M18 Phase 1 — RED. Pins POST /api/runs body-schema + passthrough:
//   - postBodySchema accepts optional baseBranch/targetBranch (z.string().min(1)
//     .optional()); a body carrying them parses (no 400 CONFIG).
//   - the parsed values are forwarded into launchRun.

const mocks = vi.hoisted(() => ({
  launchRun: vi.fn(),
  requireActiveSession: vi.fn(),
  requireProjectAction: vi.fn(),
}));

vi.mock("@/lib/services/runs", () => ({ launchRun: mocks.launchRun }));
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
