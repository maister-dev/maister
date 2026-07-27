import { NextRequest } from "next/server";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const routeMocks = vi.hoisted(() => ({
  verifyToken: vi.fn(),
  recordTokenAudit: vi.fn(async () => {}),
  bumpTokenLastUsed: vi.fn(async () => {}),
  getRunActivityResponse: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({
  getDb: () => ({ name: "db" }),
}));

vi.mock("@/lib/tokens/audit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tokens/audit")>();

  return {
    ...actual,
    recordTokenAudit: routeMocks.recordTokenAudit,
    bumpTokenLastUsed: routeMocks.bumpTokenLastUsed,
  };
});

vi.mock("@/lib/tokens/verify", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tokens/verify")>();

  return {
    ...actual,
    verifyToken: routeMocks.verifyToken,
  };
});

vi.mock("@/lib/authz", () => ({
  requireProjectActionForUser: vi.fn(async () => {}),
}));

vi.mock("@/lib/ext-activity/service", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/ext-activity/service")>();

  return {
    ...actual,
    getRunActivityResponse: routeMocks.getRunActivityResponse,
  };
});

let GET: typeof import("@/app/api/v1/ext/runs/[runId]/activity/route").GET;

beforeAll(async () => {
  const routeModule = await import(
    "@/app/api/v1/ext/runs/[runId]/activity/route"
  );

  GET = routeModule.GET;
});

beforeEach(() => {
  routeMocks.verifyToken.mockReset();
  routeMocks.recordTokenAudit.mockClear();
  routeMocks.bumpTokenLastUsed.mockClear();
  routeMocks.getRunActivityResponse.mockReset();
});

function makeRequest(runId: string, query = "", token = "secret"): NextRequest {
  const req = new NextRequest(
    `http://localhost/api/v1/ext/runs/${runId}/activity${query}`,
    { method: "GET" },
  );

  if (token.length > 0) {
    req.headers.set("authorization", `Bearer ${token}`);
  }

  return req;
}

function projectActor(overrides: Record<string, unknown> = {}) {
  return {
    tokenId: "tok-1",
    tokenKind: "project",
    projectId: "proj-1",
    actorLabel: "token:project",
    scopes: ["runs:read"],
    ownerUserId: null,
    agentId: null,
    boundRunId: null,
    ...overrides,
  };
}

describe("GET /api/v1/ext/runs/[runId]/activity", () => {
  it("returns 401 when the bearer token is missing", async () => {
    const res = await GET(makeRequest("run-1", "", ""), {
      params: Promise.resolve({ runId: "run-1" }),
    });

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toMatchObject({
      code: "UNAUTHENTICATED",
    });
    expect(routeMocks.getRunActivityResponse).not.toHaveBeenCalled();
  });

  it("returns 403 when the token lacks runs:read", async () => {
    routeMocks.verifyToken.mockResolvedValue(projectActor({ scopes: [] }));

    const res = await GET(makeRequest("run-1"), {
      params: Promise.resolve({ runId: "run-1" }),
    });

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({
      code: "UNAUTHORIZED",
      message: "insufficient scope",
    });
    expect(routeMocks.getRunActivityResponse).not.toHaveBeenCalled();
  });

  it("returns 404 when the run is missing or cross-project", async () => {
    routeMocks.verifyToken.mockResolvedValue(projectActor());
    routeMocks.getRunActivityResponse.mockResolvedValue(null);

    const res = await GET(makeRequest("run-404"), {
      params: Promise.resolve({ runId: "run-404" }),
    });

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({
      code: "NOT_FOUND",
      message: "run not found",
    });
  });

  it("serializes semantic run activity and forwards parsed query arguments", async () => {
    routeMocks.verifyToken.mockResolvedValue(projectActor());
    routeMocks.getRunActivityResponse.mockResolvedValue({
      items: [
        {
          id: "item-1",
          lastMutationId: 8n,
          ts: new Date("2026-07-26T10:00:00.000Z"),
          runId: "run-1",
          nodeId: "implement",
          kind: "message",
          salience: "normal",
          summary: "Planning the patch",
          action: {
            verb: "say",
            object: "assistant message",
            outcome: "ok",
            detail: "Planning the patch",
          },
        },
      ],
      nextSinceId: {
        lastMutationId: 8n,
        lastItemId: "item-1",
      },
      hasMore: false,
      now: {
        runId: "run-1",
        taskId: "task-1",
        taskKey: "OPS-11",
        taskTitle: "Fix flaky test",
        runKind: "flow",
        status: "Done",
        currentStepId: "implement",
        currentAttemptNumber: 1,
        startedAt: new Date("2026-07-26T09:00:00.000Z"),
        lastAction: {
          summary: "Planning the patch",
          at: new Date("2026-07-26T10:00:00.000Z"),
          salience: "normal",
          nodeId: "implement",
          lastMutationId: 8n,
        },
        liveness: {
          state: "inactive",
          summary: "completed",
          since: new Date("2026-07-26T10:05:00.000Z"),
          ageMinutes: 115,
        },
      },
    });

    const res = await GET(
      makeRequest("run-1", "?sinceId=4&limit=25&salience=normal"),
      {
        params: Promise.resolve({ runId: "run-1" }),
      },
    );

    expect(res.status).toBe(200);
    expect(routeMocks.getRunActivityResponse).toHaveBeenCalledWith(
      "proj-1",
      "run-1",
      {
        sinceId: {
          lastMutationId: 4n,
          lastItemId: null,
        },
        limit: 25,
        salience: "normal",
        client: { name: "db" },
      },
    );
    await expect(res.json()).resolves.toEqual({
      items: [
        {
          id: "item-1",
          lastMutationId: "8",
          ts: "2026-07-26T10:00:00.000Z",
          runId: "run-1",
          nodeId: "implement",
          kind: "message",
          salience: "normal",
          summary: "Planning the patch",
          action: {
            verb: "say",
            object: "assistant message",
            outcome: "ok",
            detail: "Planning the patch",
          },
        },
      ],
      nextSinceId: "8:item-1",
      hasMore: false,
      now: {
        runId: "run-1",
        taskId: "task-1",
        taskKey: "OPS-11",
        taskTitle: "Fix flaky test",
        runKind: "flow",
        status: "Done",
        currentStepId: "implement",
        currentAttemptNumber: 1,
        startedAt: "2026-07-26T09:00:00.000Z",
        lastAction: {
          summary: "Planning the patch",
          at: "2026-07-26T10:00:00.000Z",
          salience: "normal",
          nodeId: "implement",
          lastMutationId: "8",
        },
        liveness: {
          state: "inactive",
          summary: "completed",
          since: "2026-07-26T10:05:00.000Z",
          ageMinutes: 115,
        },
      },
    });
  });

  it("returns 422 for invalid sinceId, limit, or salience", async () => {
    routeMocks.verifyToken.mockResolvedValue(projectActor());

    const badCursor = await GET(makeRequest("run-1", "?sinceId=oops"), {
      params: Promise.resolve({ runId: "run-1" }),
    });
    const badLimit = await GET(makeRequest("run-1", "?limit=0"), {
      params: Promise.resolve({ runId: "run-1" }),
    });
    const badSalience = await GET(makeRequest("run-1", "?salience=urgent"), {
      params: Promise.resolve({ runId: "run-1" }),
    });

    expect(badCursor.status).toBe(422);
    await expect(badCursor.json()).resolves.toMatchObject({ code: "CONFIG" });
    expect(badLimit.status).toBe(422);
    await expect(badLimit.json()).resolves.toMatchObject({ code: "CONFIG" });
    expect(badSalience.status).toBe(422);
    await expect(badSalience.json()).resolves.toMatchObject({
      code: "CONFIG",
    });
    expect(routeMocks.getRunActivityResponse).not.toHaveBeenCalled();
  });

  it("accepts opaque composite sinceId cursors", async () => {
    routeMocks.verifyToken.mockResolvedValue(projectActor());
    routeMocks.getRunActivityResponse.mockResolvedValue({
      items: [],
      nextSinceId: {
        lastMutationId: 8n,
        lastItemId: "item-2",
      },
      hasMore: false,
      now: {
        runId: "run-1",
        taskId: null,
        taskKey: null,
        taskTitle: null,
        runKind: "agent",
        status: "Running",
        currentStepId: null,
        currentAttemptNumber: null,
        startedAt: null,
        lastAction: null,
        liveness: {
          state: "working",
          summary: "working",
          since: null,
          ageMinutes: null,
        },
      },
    });

    const res = await GET(
      makeRequest("run-1", "?sinceId=8:item-1&limit=25&salience=normal"),
      {
        params: Promise.resolve({ runId: "run-1" }),
      },
    );

    expect(res.status).toBe(200);
    expect(routeMocks.getRunActivityResponse).toHaveBeenCalledWith(
      "proj-1",
      "run-1",
      {
        sinceId: {
          lastMutationId: 8n,
          lastItemId: "item-1",
        },
        limit: 25,
        salience: "normal",
        client: { name: "db" },
      },
    );
  });
});
