import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MaisterError } from "@/lib/errors-core";

const mocks = vi.hoisted(() => ({
  getProjectAutomationDetail: vi.fn(),
  listProjectAutomations: vi.fn(),
  requireActiveSession: vi.fn(),
  requireProjectAction: vi.fn(),
  resolveProject: vi.fn(),
}));

vi.mock("@/lib/authz", () => ({
  requireActiveSession: mocks.requireActiveSession,
  requireProjectAction: mocks.requireProjectAction,
}));
vi.mock("@/lib/api/project-route-helpers", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/api/project-route-helpers")>();

  return { ...actual, resolveProject: mocks.resolveProject };
});
vi.mock("@/lib/scheduled-launches/queries", () => ({
  getProjectAutomationDetail: mocks.getProjectAutomationDetail,
  listProjectAutomations: mocks.listProjectAutomations,
}));

function params(extra?: Record<string, string>): {
  params: Promise<{ slug: string; kind: string; automationId: string }>;
} {
  return {
    params: Promise.resolve({
      slug: "demo",
      kind: "one_time_task_launch",
      automationId: "automation-1",
      ...extra,
    }),
  };
}

function request(url: string): NextRequest {
  return new NextRequest(url);
}

let collection: typeof import("../route");
let detail: typeof import("../[kind]/[automationId]/route");

beforeEach(async () => {
  mocks.requireActiveSession.mockResolvedValue({ id: "user-1" });
  mocks.requireProjectAction.mockResolvedValue({ role: "viewer" });
  mocks.resolveProject.mockResolvedValue({ id: "project-1" });
  mocks.listProjectAutomations.mockResolvedValue({
    rows: [{ id: "automation-1", type: "one_time_task_launch" }],
    nextCursor: "next",
  });
  mocks.getProjectAutomationDetail.mockResolvedValue({
    id: "automation-1",
    type: "one_time_task_launch",
  });

  collection = await import("../route");
  detail = await import("../[kind]/[automationId]/route");
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/projects/[slug]/automations", () => {
  it("uses a bounded cursor page and server-derived project identity", async () => {
    const response = await collection.GET(
      request("http://x/api/projects/demo/automations?limit=2&cursor=cursor-a"),
      params(),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      rows: [{ id: "automation-1", type: "one_time_task_launch" }],
      nextCursor: "next",
    });
    expect(mocks.listProjectAutomations).toHaveBeenCalledWith({
      cursor: "cursor-a",
      limit: 2,
      projectId: "project-1",
      projectSlug: "demo",
    });
  });

  it("rejects an out-of-range page limit without invoking the aggregate query", async () => {
    const response = await collection.GET(
      request("http://x/api/projects/demo/automations?limit=51"),
      params(),
    );

    expect(response.status).toBe(400);
    expect(mocks.listProjectAutomations).not.toHaveBeenCalled();
  });

  it("requires authentication before resolving the project", async () => {
    mocks.requireActiveSession.mockRejectedValue(
      new MaisterError("UNAUTHENTICATED", "no session"),
    );

    const response = await collection.GET(
      request("http://x/api/projects/demo/automations"),
      params(),
    );

    expect(response.status).toBe(401);
    expect(mocks.resolveProject).not.toHaveBeenCalled();
  });
});

describe("GET /api/projects/[slug]/automations/[kind]/[automationId]", () => {
  it("returns a typed detail only inside the resolved project", async () => {
    const response = await detail.GET(
      request(
        "http://x/api/projects/demo/automations/one_time_task_launch/automation-1",
      ),
      params(),
    );

    expect(response.status).toBe(200);
    expect(mocks.getProjectAutomationDetail).toHaveBeenCalledWith({
      automationId: "automation-1",
      kind: "one_time_task_launch",
      projectId: "project-1",
      projectSlug: "demo",
    });
  });

  it("returns no-probe 404 for an automation outside the project", async () => {
    mocks.getProjectAutomationDetail.mockResolvedValue(null);

    const response = await detail.GET(
      request(
        "http://x/api/projects/demo/automations/one_time_task_launch/foreign",
      ),
      params({ automationId: "foreign" }),
    );

    expect(response.status).toBe(404);
  });
});
