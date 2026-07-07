import type { NextRequest } from "next/server";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  launchAgentRun: vi.fn(),
  projectRows: [] as unknown[],
  requireActiveSession: vi.fn(),
  requireProjectAction: vi.fn(),
}));

vi.mock("@/lib/agents/launch", () => ({
  launchAgentRun: mocks.launchAgentRun,
}));
vi.mock("@/lib/authz", () => ({
  requireActiveSession: mocks.requireActiveSession,
  requireProjectAction: mocks.requireProjectAction,
}));
vi.mock("@/lib/db/client", () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({ where: async () => mocks.projectRows }),
    }),
  }),
}));

const params = (agentId = "core%3Atriager") => ({
  params: Promise.resolve({ slug: "proj", agentId }),
});

function jsonRequest(body?: Record<string, unknown>): NextRequest {
  return new Request("http://x/api/projects/proj/agents/core:triager/launch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }) as NextRequest;
}

let route: typeof import("../route");

beforeEach(async () => {
  mocks.launchAgentRun.mockResolvedValue({ runId: "run-1", status: "Pending" });
  mocks.projectRows = [{ id: "project-1", archivedAt: null }];
  mocks.requireActiveSession.mockResolvedValue({ id: "user-1" });
  mocks.requireProjectAction.mockResolvedValue({ role: "member" });

  route = await import("../route");
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/projects/[slug]/agents/[agentId]/launch", () => {
  it("accepts the documented workspace launch override and forwards it to launchAgentRun", async () => {
    const res = await route.POST(
      jsonRequest({
        runnerId: "opencode-default",
        workspace: "repo_read",
      }),
      params(),
    );

    expect(res.status).toBe(202);
    expect(mocks.requireProjectAction).toHaveBeenCalledWith(
      "project-1",
      "launchRun",
    );
    expect(mocks.launchAgentRun).toHaveBeenCalledWith({
      agentId: "core:triager",
      projectId: "project-1",
      taskId: null,
      launchOverrideRunnerId: "opencode-default",
      workspace: "repo_read",
      trigger: { source: "manual" },
    });
  });
});
