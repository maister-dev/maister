import type { NextRequest, NextResponse } from "next/server";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  handleExt: vi.fn(),
  recordRequiredTokenAudit: vi.fn(),
  getDb: vi.fn(),
  appendExperimentAdvisory: vi.fn(),
}));

vi.mock("@/lib/tokens/ext-handler", () => ({
  handleExt: mocks.handleExt,
  recordRequiredTokenAudit: mocks.recordRequiredTokenAudit,
}));

vi.mock("@/lib/db/client", () => ({
  getDb: mocks.getDb,
}));

vi.mock("@/lib/experiments/advisory", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/experiments/advisory")>()),
  appendExperimentAdvisory: mocks.appendExperimentAdvisory,
}));

type RouteModule = typeof import("../route");

let route: RouteModule;

function request(body: Record<string, unknown>): NextRequest {
  return new Request(
    "http://x/api/v1/ext/projects/demo/experiments/exp-1/advisory",
    {
      method: "POST",
      headers: { authorization: "Bearer token" },
      body: JSON.stringify(body),
    },
  ) as NextRequest;
}

function malformedRequest(): NextRequest {
  return new Request(
    "http://x/api/v1/ext/projects/demo/experiments/exp-1/advisory",
    {
      method: "POST",
      headers: { authorization: "Bearer token" },
      body: "{",
    },
  ) as NextRequest;
}

function params() {
  return { params: Promise.resolve({ slug: "demo", experimentId: "exp-1" }) };
}

beforeEach(async () => {
  const db = { transaction: vi.fn() };

  mocks.getDb.mockReturnValue(db);
  mocks.recordRequiredTokenAudit.mockResolvedValue(undefined);
  mocks.appendExperimentAdvisory.mockResolvedValue({
    experimentId: "exp-1",
    advisory: { advisoryOrdinal: 1 },
  });
  mocks.handleExt.mockImplementation(
    async (
      _req: Request,
      _opts: Record<string, unknown>,
      work: (ctx: {
        projectId: string;
        actor: {
          tokenId: string;
          actorLabel: string;
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
          actorLabel: "agent:core:experiment-judge",
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

describe("POST /api/v1/ext/projects/[slug]/experiments/[experimentId]/advisory", () => {
  it("uses experiments:advise, parses body, and leaves success audit in work", async () => {
    const body = {
      scores: { correctness: { claude: 5, codex: 4 } },
      summary: "Claude is stronger.",
      confidence: 0.7,
    };
    const res = await route.POST(request(body), params());

    expect(res.status).toBe(200);
    expect(mocks.handleExt).toHaveBeenCalledWith(
      expect.any(Request),
      expect.objectContaining({
        slug: "demo",
        scopeLabel: "experiments:advise",
        endpoint:
          "POST /api/v1/ext/projects/[slug]/experiments/[experimentId]/advisory",
        method: "POST",
        successAuditInWork: true,
      }),
      expect.any(Function),
    );
    expect(mocks.appendExperimentAdvisory).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "project-1",
        experimentId: "exp-1",
        actorLabel: "agent:core:experiment-judge",
        agentRunId: "judge-run-1",
        input: body,
        audit: expect.any(Function),
      }),
      expect.anything(),
    );
  });

  it("rejects non-judge agent tokens before appending an advisory", async () => {
    mocks.handleExt.mockImplementationOnce(
      async (
        _req: Request,
        _opts: Record<string, unknown>,
        work: (ctx: {
          projectId: string;
          actor: {
            tokenId: string;
            actorLabel: string;
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
            actorLabel: "agent:core:aif-plan",
            tokenKind: "agent",
            agentId: "core:aif-plan",
            boundRunId: "run-other",
          },
        }),
    );

    const res = await route.POST(
      request({
        scores: { correctness: { claude: 5, codex: 4 } },
        summary: "Claude is stronger.",
      }),
      params(),
    );

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "UNAUTHORIZED" });
    expect(mocks.appendExperimentAdvisory).not.toHaveBeenCalled();
  });

  it("rejects body-supplied agentRunId instead of accepting spoofed attribution", async () => {
    const res = await route.POST(
      request({
        scores: { correctness: { claude: 5, codex: 4 } },
        summary: "Claude is stronger.",
        agentRunId: "spoofed-run",
      }),
      params(),
    );

    expect(res.status).toBe(422);
    expect(mocks.appendExperimentAdvisory).not.toHaveBeenCalled();
  });

  it("maps malformed JSON to CONFIG instead of throwing", async () => {
    const res = await route.POST(malformedRequest(), params());

    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ code: "CONFIG" });
    expect(mocks.appendExperimentAdvisory).not.toHaveBeenCalled();
  });
});
