import type { NextRequest } from "next/server";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MaisterError } from "@/lib/errors-core";

const mocks = vi.hoisted(() => ({
  requireActiveSession: vi.fn(),
  requireProjectAction: vi.fn(),
  resolveProject: vi.fn(),
  concludeExperiment: vi.fn(),
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
  concludeExperiment: mocks.concludeExperiment,
}));

type RouteModule = typeof import("../route");

let route: RouteModule;

function request(body: Record<string, unknown>): NextRequest {
  return new Request("http://x/api/projects/demo/experiments/exp-1/conclude", {
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
  mocks.concludeExperiment.mockResolvedValue({
    id: "exp-1",
    projectId: "project-1",
    taskId: "task-1",
    title: "Compare",
    description: null,
    status: "concluded",
    baseBranch: "main",
    baseCommit: "a".repeat(40),
    variants: [],
    rubric: { criteria: [] },
    verdict: { human: { outcome: "winner", winnerVariantKey: "claude" } },
    createdAt: "2026-07-03T10:00:00.000Z",
    launchedAt: "2026-07-03T10:01:00.000Z",
    comparableAt: "2026-07-03T10:05:00.000Z",
    concludedAt: "2026-07-03T10:06:00.000Z",
    abandonedAt: null,
  });

  route = await import("../route");
});

afterEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

describe("POST /api/projects/[slug]/experiments/[experimentId]/conclude", () => {
  it("requires concludeExperiments and forwards a human actor verdict", async () => {
    const body = {
      outcome: "winner",
      winnerVariantKey: "claude",
      abandonLosers: true,
    };

    const res = await route.POST(request(body), params());

    expect(res.status).toBe(200);
    expect(mocks.requireProjectAction).toHaveBeenCalledWith(
      "project-1",
      "concludeExperiments",
    );
    expect(mocks.concludeExperiment).toHaveBeenCalledWith({
      projectId: "project-1",
      experimentId: "exp-1",
      actor: { type: "user", id: "user-1" },
      input: body,
    });

    const dto = (await res.json()) as Record<string, unknown>;

    expect(Object.keys(dto).sort()).toEqual([
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

  it("checks project auth before body validation or service side effects", async () => {
    mocks.requireProjectAction.mockRejectedValueOnce(
      new MaisterError("UNAUTHORIZED", "member role required"),
    );

    const res = await route.POST(request({ outcome: 7 }), params());
    const payload = (await res.json()) as { code?: string };

    expect(res.status).toBe(403);
    expect(payload.code).toBe("UNAUTHORIZED");
    expect(mocks.concludeExperiment).not.toHaveBeenCalled();
  });
});
