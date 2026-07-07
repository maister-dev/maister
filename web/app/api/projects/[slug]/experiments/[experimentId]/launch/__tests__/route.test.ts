import type { NextRequest } from "next/server";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MaisterError } from "@/lib/errors-core";

const mocks = vi.hoisted(() => ({
  requireActiveSession: vi.fn(),
  requireProjectAction: vi.fn(),
  resolveProject: vi.fn(),
  launchExperimentVariants: vi.fn(),
}));

vi.mock("@/lib/authz", () => ({
  requireActiveSession: mocks.requireActiveSession,
  requireProjectAction: mocks.requireProjectAction,
}));

vi.mock("@/lib/api/project-route-helpers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/project-route-helpers")>()),
  resolveProject: mocks.resolveProject,
}));

vi.mock("@/lib/experiments/launch", () => ({
  launchExperimentVariants: mocks.launchExperimentVariants,
}));

type RouteModule = typeof import("../route");

let route: RouteModule;

function request(body: Record<string, unknown>): NextRequest {
  return new Request("http://x/api/projects/demo/experiments/exp-1/launch", {
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
  mocks.launchExperimentVariants.mockResolvedValue({
    experimentId: "exp-1",
    outcomes: [
      {
        variantKey: "claude",
        replicateOrdinal: 1,
        runId: "run-1",
        status: "Running",
      },
    ],
  });

  route = await import("../route");
});

afterEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

describe("POST /api/projects/[slug]/experiments/[experimentId]/launch", () => {
  it("requires manageExperiments and forwards the parsed launch body", async () => {
    const body = { variants: ["claude"], replicates: 2 };
    const res = await route.POST(request(body), params());

    expect(res.status).toBe(200);
    expect(mocks.requireProjectAction).toHaveBeenCalledWith(
      "project-1",
      "manageExperiments",
    );
    expect(mocks.launchExperimentVariants).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "project-1",
        experimentId: "exp-1",
        actorUserId: "user-1",
        input: body,
        authorizeRunAction: expect.any(Function),
      }),
    );
    await expect(res.json()).resolves.toEqual({
      experimentId: "exp-1",
      outcomes: [
        {
          variantKey: "claude",
          replicateOrdinal: 1,
          runId: "run-1",
          status: "Running",
        },
      ],
    });
  });

  it("checks project auth before body validation or launch side effects", async () => {
    mocks.requireProjectAction.mockRejectedValueOnce(
      new MaisterError("UNAUTHORIZED", "member role required"),
    );

    const res = await route.POST(request({ variants: 7 }), params());
    const body = (await res.json()) as { code?: string };

    expect(res.status).toBe(403);
    expect(body.code).toBe("UNAUTHORIZED");
    expect(mocks.launchExperimentVariants).not.toHaveBeenCalled();
  });
});
