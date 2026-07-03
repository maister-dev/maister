import type { NextRequest } from "next/server";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireActiveSession: vi.fn(),
  requireProjectAction: vi.fn(),
  resolveProject: vi.fn(),
  getExperimentDetail: vi.fn(),
}));

vi.mock("@/lib/authz", () => ({
  requireActiveSession: mocks.requireActiveSession,
  requireProjectAction: mocks.requireProjectAction,
}));

vi.mock("@/lib/api/project-route-helpers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/project-route-helpers")>()),
  resolveProject: mocks.resolveProject,
}));

vi.mock("@/lib/experiments/service", () => ({
  getExperimentDetail: mocks.getExperimentDetail,
}));

type RouteModule = typeof import("../route");

let route: RouteModule;

function request(): NextRequest {
  return new Request("http://x/api/projects/demo/experiments/exp-1", {
    method: "GET",
  }) as NextRequest;
}

function params(experimentId = "exp-1") {
  return { params: Promise.resolve({ slug: "demo", experimentId }) };
}

beforeEach(async () => {
  mocks.requireActiveSession.mockResolvedValue({ id: "user-1" });
  mocks.requireProjectAction.mockResolvedValue({ role: "viewer" });
  mocks.resolveProject.mockResolvedValue({ id: "project-1" });
  mocks.getExperimentDetail.mockResolvedValue({
    id: "exp-1",
    projectId: "project-1",
    taskId: "task-1",
    title: "Compare runners",
    description: null,
    status: "draft",
    baseBranch: "main",
    baseCommit: "a".repeat(40),
    variants: [
      { key: "claude", label: "Claude", config: {} },
      { key: "codex", label: "Codex", config: {} },
    ],
    rubric: { criteria: [] },
    verdict: null,
    createdAt: "2026-07-03T10:00:00.000Z",
    launchedAt: null,
    comparableAt: null,
    concludedAt: null,
    abandonedAt: null,
  });

  route = await import("../route");
});

afterEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

describe("GET /api/projects/[slug]/experiments/[experimentId]", () => {
  it("requires readExperiments and returns an explicit detail DTO", async () => {
    const res = await route.GET(request(), params());
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(mocks.requireProjectAction).toHaveBeenCalledWith(
      "project-1",
      "readExperiments",
    );
    expect(mocks.getExperimentDetail).toHaveBeenCalledWith(
      "project-1",
      "exp-1",
    );
    expect(Object.keys(body).sort()).toEqual([
      "abandonedAt",
      "baseBranch",
      "baseCommit",
      "comparableAt",
      "concludedAt",
      "createdAt",
      "description",
      "id",
      "launchedAt",
      "projectId",
      "rubric",
      "status",
      "taskId",
      "title",
      "variants",
      "verdict",
    ]);
  });

  it("returns 404 when the experiment does not belong to the slug-derived project", async () => {
    mocks.getExperimentDetail.mockResolvedValueOnce(null);

    const res = await route.GET(request(), params("foreign-exp"));
    const body = (await res.json()) as { code?: string };

    expect(res.status).toBe(404);
    expect(body.code).toBe("NOT_FOUND");
  });
});
