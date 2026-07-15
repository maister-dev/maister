import type { NextRequest } from "next/server";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MaisterError } from "@/lib/errors-core";

const mocks = vi.hoisted(() => ({
  cancelScheduledLaunch: vi.fn(),
  createScheduledLaunch: vi.fn(),
  findScheduledLaunchForProject: vi.fn(),
  getScheduledLaunchDto: vi.fn(),
  listScheduledLaunchEvents: vi.fn(),
  rearmScheduledLaunch: vi.fn(),
  requireActiveSession: vi.fn(),
  requireProjectAction: vi.fn(),
  resolveProject: vi.fn(),
  runScheduledLaunchNow: vi.fn(),
}));

vi.mock("@/lib/authz", () => ({
  requireActiveSession: mocks.requireActiveSession,
  requireProjectAction: mocks.requireProjectAction,
}));
vi.mock("@/lib/api/project-route-helpers", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@/lib/api/project-route-helpers")
  >();

  return { ...actual, resolveProject: mocks.resolveProject };
});
vi.mock("@/lib/scheduled-launches/service", () => ({
  cancelScheduledLaunch: mocks.cancelScheduledLaunch,
  createScheduledLaunch: mocks.createScheduledLaunch,
  rearmScheduledLaunch: mocks.rearmScheduledLaunch,
  runScheduledLaunchNow: mocks.runScheduledLaunchNow,
}));
vi.mock("@/lib/scheduled-launches/queries", () => ({
  findScheduledLaunchForProject: mocks.findScheduledLaunchForProject,
  getScheduledLaunchDto: mocks.getScheduledLaunchDto,
  listScheduledLaunchEvents: mocks.listScheduledLaunchEvents,
}));

const validBody = {
  taskId: "b0cc024a-0875-4ff6-9358-86099b5e5bc2",
  scheduledLocalTime: "2026-12-01T10:00",
  timezone: "UTC",
  launchRequest: {
    flowId: "flow-1",
    runnerId: "runner-1",
  },
};

const dto = {
  id: "scheduled-1",
  revision: 2,
  launchRequest: validBody.launchRequest,
};

function params(extra?: Record<string, string>): {
  params: Promise<{ slug: string; launchId: string }>;
} {
  return {
    params: Promise.resolve({ slug: "demo", launchId: "scheduled-1", ...extra }),
  };
}

function jsonRequest(
  method: string,
  body?: Record<string, unknown>,
  headers?: Record<string, string>,
): NextRequest {
  return new Request("http://x/api/projects/demo/scheduled-launches", {
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { "content-type": "application/json", ...headers },
    method,
  }) as NextRequest;
}

let collection: typeof import("../route");
let item: typeof import("../[launchId]/route");
let cancel: typeof import("../[launchId]/cancel/route");
let runNow: typeof import("../[launchId]/run-now/route");

beforeEach(async () => {
  mocks.requireActiveSession.mockResolvedValue({ id: "user-1" });
  mocks.requireProjectAction.mockResolvedValue({ role: "member" });
  mocks.resolveProject.mockResolvedValue({ id: "project-1" });
  mocks.createScheduledLaunch.mockResolvedValue({
    replayed: false,
    intent: { id: "scheduled-1" },
  });
  mocks.getScheduledLaunchDto.mockResolvedValue(dto);
  mocks.findScheduledLaunchForProject.mockResolvedValue({
    id: "scheduled-1",
    launchRequest: validBody.launchRequest,
  });
  mocks.listScheduledLaunchEvents.mockResolvedValue([]);
  mocks.rearmScheduledLaunch.mockResolvedValue({ id: "scheduled-1" });
  mocks.cancelScheduledLaunch.mockResolvedValue({ id: "scheduled-1" });
  mocks.runScheduledLaunchNow.mockResolvedValue({ state: "Launched" });

  collection = await import("../route");
  item = await import("../[launchId]/route");
  cancel = await import("../[launchId]/cancel/route");
  runNow = await import("../[launchId]/run-now/route");
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/projects/[slug]/scheduled-launches", () => {
  it("authorizes before parsing an invalid browser body", async () => {
    mocks.requireActiveSession.mockRejectedValue(
      new MaisterError("UNAUTHENTICATED", "no session"),
    );

    const response = await collection.POST(
      jsonRequest("POST", { invalid: true }),
      params(),
    );

    expect(response.status).toBe(401);
    expect(mocks.resolveProject).not.toHaveBeenCalled();
    expect(mocks.createScheduledLaunch).not.toHaveBeenCalled();
  });

  it("stores only an intent and returns its ETag", async () => {
    const response = await collection.POST(
      jsonRequest("POST", validBody, { "Idempotency-Key": "intent-a" }),
      params(),
    );

    expect(response.status).toBe(201);
    expect(response.headers.get("ETag")).toBe('"2"');
    expect(mocks.createScheduledLaunch).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: "user-1",
        idempotencyKey: "intent-a",
        projectId: "project-1",
        taskId: validBody.taskId,
      }),
    );
  });

  it("maps an invalid launch request body to CONFIG without creating an intent", async () => {
    const response = await collection.POST(
      jsonRequest(
        "POST",
        { ...validBody, launchRequest: { allowConcurrent: true } },
        { "Idempotency-Key": "intent-a" },
      ),
      params(),
    );

    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe("CONFIG");
    expect(mocks.createScheduledLaunch).not.toHaveBeenCalled();
  });

  it("returns 200 for a same-hash idempotency replay", async () => {
    mocks.createScheduledLaunch.mockResolvedValue({
      replayed: true,
      intent: { id: "scheduled-1" },
    });

    const response = await collection.POST(
      jsonRequest("POST", validBody, { "Idempotency-Key": "intent-a" }),
      params(),
    );

    expect(response.status).toBe(200);
  });
});

describe("one-time scheduled launch mutations", () => {
  it("rejects a malformed ETag before it reads or mutates the launch", async () => {
    const response = await item.PATCH(
      jsonRequest("PATCH", validBody, { "If-Match": "2" }),
      params({ launchId: "scheduled-1" }),
    );

    expect(response.status).toBe(409);
    expect(mocks.getScheduledLaunchDto).not.toHaveBeenCalled();
    expect(mocks.rearmScheduledLaunch).not.toHaveBeenCalled();
  });

  it("does not disclose or dispatch an intent outside the resolved project", async () => {
    mocks.findScheduledLaunchForProject.mockResolvedValue(null);

    const response = await runNow.POST(
      jsonRequest("POST", undefined, { "If-Match": '"2"' }),
      params({ launchId: "foreign" }),
    );

    expect(response.status).toBe(404);
    expect(mocks.runScheduledLaunchNow).not.toHaveBeenCalled();
  });

  it("passes the exact ETag revision to both cancellation and Run now", async () => {
    const cancelResponse = await cancel.POST(
      jsonRequest("POST", undefined, { "If-Match": '"2"' }),
      params({ launchId: "scheduled-1" }),
    );
    const runNowResponse = await runNow.POST(
      jsonRequest("POST", undefined, { "If-Match": '"2"' }),
      params({ launchId: "scheduled-1" }),
    );

    expect(cancelResponse.status).toBe(200);
    expect(runNowResponse.status).toBe(200);
    expect(mocks.cancelScheduledLaunch).toHaveBeenCalledWith(
      expect.objectContaining({ expectedRevision: 2 }),
    );
    expect(mocks.runScheduledLaunchNow).toHaveBeenCalledWith(
      expect.objectContaining({ expectedRevision: 2 }),
    );
  });
});
