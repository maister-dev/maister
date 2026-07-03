import type { NextRequest } from "next/server";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MaisterError } from "@/lib/errors-core";

const mocks = vi.hoisted(() => ({
  requireActiveSession: vi.fn(),
  requireProjectAction: vi.fn(),
  resolveProject: vi.fn(),
  abandonExperiment: vi.fn(),
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
  abandonExperiment: mocks.abandonExperiment,
}));

type RouteModule = typeof import("../route");

let route: RouteModule;

function request(body: Record<string, unknown>): NextRequest {
  return new Request("http://x/api/projects/demo/experiments/exp-1/abandon", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as NextRequest;
}

function params() {
  return { params: Promise.resolve({ slug: "demo", experimentId: "exp-1" }) };
}

beforeEach(async () => {
  mocks.requireActiveSession.mockResolvedValue({ id: "user-1" });
  mocks.requireProjectAction.mockResolvedValue({ role: "member" });
  mocks.resolveProject.mockResolvedValue({ id: "project-1" });
  mocks.abandonExperiment.mockResolvedValue({
    id: "exp-1",
    projectId: "project-1",
    taskId: "task-1",
    title: "Compare",
    description: null,
    status: "abandoned",
    baseBranch: "main",
    baseCommit: "a".repeat(40),
    variants: [],
    rubric: { criteria: [] },
    verdict: null,
    createdAt: "2026-07-03T10:00:00.000Z",
    launchedAt: "2026-07-03T10:01:00.000Z",
    comparableAt: null,
    concludedAt: null,
    abandonedAt: "2026-07-03T10:06:00.000Z",
  });

  route = await import("../route");
});

afterEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

describe("POST /api/projects/[slug]/experiments/[experimentId]/abandon", () => {
  it("requires manageExperiments and forwards stopLiveRuns explicitly", async () => {
    const body = { reason: "superseded", stopLiveRuns: true };

    const res = await route.POST(request(body), params());

    expect(res.status).toBe(200);
    expect(mocks.requireProjectAction).toHaveBeenCalledWith(
      "project-1",
      "manageExperiments",
    );
    expect(mocks.abandonExperiment).toHaveBeenCalledWith({
      projectId: "project-1",
      experimentId: "exp-1",
      actorUserId: "user-1",
      input: body,
    });

    const dto = (await res.json()) as Record<string, unknown>;

    expect(dto.status).toBe("abandoned");
    expect(dto).not.toHaveProperty("createdByUserId");
  });

  it("checks project auth before body validation or service side effects", async () => {
    mocks.requireProjectAction.mockRejectedValueOnce(
      new MaisterError("UNAUTHORIZED", "member role required"),
    );

    const res = await route.POST(request({ stopLiveRuns: "yes" }), params());
    const payload = (await res.json()) as { code?: string };

    expect(res.status).toBe(403);
    expect(payload.code).toBe("UNAUTHORIZED");
    expect(mocks.abandonExperiment).not.toHaveBeenCalled();
  });
});
