import { NextRequest } from "next/server";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const routeMocks = vi.hoisted(() => ({
  verifyToken: vi.fn(),
  recordTokenAudit: vi.fn(async () => {}),
  bumpTokenLastUsed: vi.fn(async () => {}),
  getActivityPulse: vi.fn(),
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
    getActivityPulse: routeMocks.getActivityPulse,
  };
});

let GET: typeof import("@/app/api/v1/ext/activity/route").GET;

beforeAll(async () => {
  const routeModule = await import("@/app/api/v1/ext/activity/route");

  GET = routeModule.GET;
});

beforeEach(() => {
  routeMocks.verifyToken.mockReset();
  routeMocks.recordTokenAudit.mockClear();
  routeMocks.bumpTokenLastUsed.mockClear();
  routeMocks.getActivityPulse.mockReset();
});

function makeRequest(query = "", token = "secret"): NextRequest {
  const req = new NextRequest(`http://localhost/api/v1/ext/activity${query}`, {
    method: "GET",
  });

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

describe("GET /api/v1/ext/activity", () => {
  it("returns 401 when the bearer token is missing", async () => {
    const res = await GET(makeRequest("", ""));

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toMatchObject({
      code: "UNAUTHENTICATED",
    });
    expect(routeMocks.getActivityPulse).not.toHaveBeenCalled();
  });

  it("returns 403 for a global token because the route is project-bound", async () => {
    routeMocks.verifyToken.mockResolvedValue(
      projectActor({
        tokenKind: "user",
        projectId: null,
        ownerUserId: "user-1",
        actorLabel: "token:user",
      }),
    );

    const res = await GET(makeRequest());

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({
      code: "UNAUTHORIZED",
      message: "project-bound token required",
    });
    expect(routeMocks.getActivityPulse).not.toHaveBeenCalled();
  });

  it("returns 403 when the token lacks runs:read", async () => {
    routeMocks.verifyToken.mockResolvedValue(projectActor({ scopes: [] }));

    const res = await GET(makeRequest());

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({
      code: "UNAUTHORIZED",
      message: "insufficient scope",
    });
    expect(routeMocks.getActivityPulse).not.toHaveBeenCalled();
  });

  it("serializes the assistant pulse and forwards parsed query arguments", async () => {
    routeMocks.verifyToken.mockResolvedValue(projectActor());
    routeMocks.getActivityPulse.mockResolvedValue({
      happened: {
        items: [
          {
            id: "14",
            ts: new Date("2026-07-26T10:00:00.000Z"),
            kind: "run.failed",
            salience: "high",
            summary: "run failed",
            action: {
              verb: "finish",
              object: "run",
              outcome: "failed",
            },
            runId: "run-1",
            taskId: "task-1",
            taskKey: "OPS-14",
            hitlRequestId: null,
            gateId: null,
          },
        ],
        nextCursor: 14n,
        hasMore: false,
      },
      now: {
        generatedAt: new Date("2026-07-26T12:00:00.000Z"),
        runs: [
          {
            runId: "run-1",
            taskId: "task-1",
            taskKey: "OPS-14",
            taskTitle: "Fix flaky test",
            runKind: "agent",
            status: "NeedsInput",
            currentStepId: null,
            currentAttemptNumber: null,
            startedAt: new Date("2026-07-26T11:50:00.000Z"),
            lastAction: null,
            liveness: {
              state: "waiting_on_human",
              summary: "waiting on human for 2 min",
              since: new Date("2026-07-26T11:58:00.000Z"),
              ageMinutes: 2,
            },
          },
        ],
      },
      needsYou: {
        generatedAt: new Date("2026-07-26T12:00:00.000Z"),
        items: [
          {
            runId: "run-1",
            taskId: "task-1",
            taskKey: "OPS-14",
            taskTitle: "Fix flaky test",
            hitlRequestId: "hitl-1",
            kind: "permission",
            title: "Fix flaky test",
            summary: "Approve the file edit",
            requestedAt: new Date("2026-07-26T11:58:00.000Z"),
            criticality: "high",
          },
        ],
      },
    });

    const res = await GET(makeRequest("?since=12&salience=normal"));

    expect(res.status).toBe(200);
    expect(routeMocks.getActivityPulse).toHaveBeenCalledWith("proj-1", {
      since: 12n,
      salience: "normal",
      client: { name: "db" },
    });
    await expect(res.json()).resolves.toEqual({
      happened: {
        items: [
          {
            id: "14",
            ts: "2026-07-26T10:00:00.000Z",
            kind: "run.failed",
            salience: "high",
            summary: "run failed",
            action: {
              verb: "finish",
              object: "run",
              outcome: "failed",
            },
            runId: "run-1",
            taskId: "task-1",
            taskKey: "OPS-14",
            hitlRequestId: null,
            gateId: null,
          },
        ],
        nextCursor: "14",
        hasMore: false,
      },
      now: {
        generatedAt: "2026-07-26T12:00:00.000Z",
        runs: [
          {
            runId: "run-1",
            taskId: "task-1",
            taskKey: "OPS-14",
            taskTitle: "Fix flaky test",
            runKind: "agent",
            status: "NeedsInput",
            currentStepId: null,
            currentAttemptNumber: null,
            startedAt: "2026-07-26T11:50:00.000Z",
            lastAction: null,
            liveness: {
              state: "waiting_on_human",
              summary: "waiting on human for 2 min",
              since: "2026-07-26T11:58:00.000Z",
              ageMinutes: 2,
            },
          },
        ],
      },
      needsYou: {
        generatedAt: "2026-07-26T12:00:00.000Z",
        items: [
          {
            runId: "run-1",
            taskId: "task-1",
            taskKey: "OPS-14",
            taskTitle: "Fix flaky test",
            hitlRequestId: "hitl-1",
            kind: "permission",
            title: "Fix flaky test",
            summary: "Approve the file edit",
            requestedAt: "2026-07-26T11:58:00.000Z",
            criticality: "high",
          },
        ],
      },
    });
  });

  it("returns 422 for an invalid cursor or salience value", async () => {
    routeMocks.verifyToken.mockResolvedValue(projectActor());

    const badCursor = await GET(makeRequest("?since=oops"));
    const badSalience = await GET(makeRequest("?salience=urgent"));

    expect(badCursor.status).toBe(422);
    await expect(badCursor.json()).resolves.toMatchObject({
      code: "CONFIG",
    });
    expect(badSalience.status).toBe(422);
    await expect(badSalience.json()).resolves.toMatchObject({
      code: "CONFIG",
    });
    expect(routeMocks.getActivityPulse).not.toHaveBeenCalled();
  });
});
