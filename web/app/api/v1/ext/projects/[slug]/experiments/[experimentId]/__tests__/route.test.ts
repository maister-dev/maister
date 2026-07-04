import type { NextRequest, NextResponse } from "next/server";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  handleExt: vi.fn(),
  getExperimentComparison: vi.fn(),
}));

vi.mock("@/lib/tokens/ext-handler", () => ({
  handleExt: mocks.handleExt,
}));

vi.mock("@/lib/experiments/comparison", () => ({
  getExperimentComparison: mocks.getExperimentComparison,
}));

type RouteModule = typeof import("../route");

let route: RouteModule;

function request(): NextRequest {
  return new Request(
    "http://x/api/v1/ext/projects/demo/experiments/exp-1",
    {
      headers: { authorization: "Bearer token" },
    },
  ) as NextRequest;
}

function params() {
  return { params: Promise.resolve({ slug: "demo", experimentId: "exp-1" }) };
}

beforeEach(async () => {
  mocks.getExperimentComparison.mockResolvedValue({
    experiment: { id: "exp-1", status: "comparable" },
    variants: [],
    runs: [],
    verdict: null,
    generatedAt: "2026-07-03T10:00:00.000Z",
  });
  mocks.handleExt.mockImplementation(
    async (
      _req: Request,
      _opts: Record<string, unknown>,
      work: (ctx: {
        projectId: string;
        actor: {
          tokenId: string;
          tokenKind: string;
          agentId: string;
          boundRunId: string;
        };
      }) => Promise<NextResponse>,
    ) =>
      work({
        projectId: "project-1",
        actor: {
          tokenId: "tok-1",
          tokenKind: "agent",
          agentId: "core:experiment-judge",
          boundRunId: "judge-run-1",
        },
      }),
  );

  route = await import("../route");
});

afterEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

describe("GET /api/v1/ext/projects/[slug]/experiments/[experimentId]", () => {
  it("uses experiments:read scope and forwards an external viewer", async () => {
    const res = await route.GET(request(), params());
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(mocks.handleExt).toHaveBeenCalledWith(
      expect.any(Request),
      {
        slug: "demo",
        scopeLabel: "experiments:read",
        endpoint: "GET /api/v1/ext/projects/[slug]/experiments/[experimentId]",
        method: "GET",
      },
      expect.any(Function),
    );
    expect(mocks.getExperimentComparison).toHaveBeenCalledWith({
      projectId: "project-1",
      experimentId: "exp-1",
      viewerType: "external",
    });
    expect(Object.keys(body).sort()).toEqual([
      "experiment",
      "generatedAt",
      "runs",
      "variants",
      "verdict",
    ]);
  });

  it("rejects non-judge agent tokens before returning the comparison", async () => {
    mocks.handleExt.mockImplementationOnce(
      async (
        _req: Request,
        _opts: Record<string, unknown>,
        work: (ctx: {
          projectId: string;
          actor: {
            tokenId: string;
            tokenKind: string;
            agentId: string;
            boundRunId: string;
          };
        }) => Promise<NextResponse>,
      ) =>
        work({
          projectId: "project-1",
          actor: {
            tokenId: "tok-2",
            tokenKind: "agent",
            agentId: "core:aif-plan",
            boundRunId: "run-other",
          },
        }),
    );

    const res = await route.GET(request(), params());

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "UNAUTHORIZED" });
    expect(mocks.getExperimentComparison).not.toHaveBeenCalled();
  });
});
