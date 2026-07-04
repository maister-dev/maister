import type { NextRequest } from "next/server";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireActiveSession: vi.fn(),
  requireProjectAction: vi.fn(),
  resolveProject: vi.fn(),
  getExperimentComparison: vi.fn(),
}));

vi.mock("@/lib/authz", () => ({
  requireActiveSession: mocks.requireActiveSession,
  requireProjectAction: mocks.requireProjectAction,
}));

vi.mock("@/lib/api/project-route-helpers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/project-route-helpers")>()),
  resolveProject: mocks.resolveProject,
}));

vi.mock("@/lib/experiments/comparison", () => ({
  getExperimentComparison: mocks.getExperimentComparison,
}));

type RouteModule = typeof import("../route");

let route: RouteModule;

function request(): NextRequest {
  return new Request(
    "http://x/api/projects/demo/experiments/exp-1/comparison",
  ) as NextRequest;
}

function params() {
  return { params: Promise.resolve({ slug: "demo", experimentId: "exp-1" }) };
}

beforeEach(async () => {
  mocks.requireActiveSession.mockResolvedValue({ id: "user-1" });
  mocks.requireProjectAction.mockResolvedValue({ role: "viewer" });
  mocks.resolveProject.mockResolvedValue({ id: "project-1" });
  mocks.getExperimentComparison.mockResolvedValue({
    experiment: { id: "exp-1", status: "comparable" },
    variants: [],
    runs: [],
    verdict: null,
    generatedAt: "2026-07-03T10:00:00.000Z",
  });

  route = await import("../route");
});

afterEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

describe("GET /api/projects/[slug]/experiments/[experimentId]/comparison", () => {
  it("requires readExperiments and forwards a session viewer", async () => {
    const res = await route.GET(request(), params());
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(mocks.requireProjectAction).toHaveBeenCalledWith(
      "project-1",
      "readExperiments",
    );
    expect(mocks.getExperimentComparison).toHaveBeenCalledWith({
      projectId: "project-1",
      experimentId: "exp-1",
      viewerType: "session",
    });
    expect(Object.keys(body).sort()).toEqual([
      "experiment",
      "generatedAt",
      "runs",
      "variants",
      "verdict",
    ]);
  });

  it("maps a missing experiment to a 404", async () => {
    const { ExperimentNotFoundError } = await import(
      "@/lib/experiments/errors"
    );

    mocks.getExperimentComparison.mockRejectedValueOnce(
      new ExperimentNotFoundError("exp-404"),
    );

    const res = await route.GET(request(), params());
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(404);
    expect(body).toMatchObject({ code: "NOT_FOUND" });
  });
});
