// Route-contract pins for /api/runs/{runId}/hitl/{hitlRequestId}/chat —
// the implemented envelope documented in docs/api/web.openapi.yaml:
//   GET  200 {runId, hitlRequestId, availability, idleResumeCost, messages}
//        guarded by answerHitl (member+, ADR-078 — NOT readBoard)
//   POST 200 {runId, hitlRequestId, userMessage, agentMessage, resumed}
//        (synchronous reply, not 202 {ok, seq}) + the error-status map
//        CONFIG→400, PRECONDITION/CONFLICT→409, CHECKPOINT/ACP_PROTOCOL→502.

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { GET, POST } from "../runs/[runId]/hitl/[hitlRequestId]/chat/route";

import { MaisterError } from "@/lib/errors";

const requireActiveSessionSpy = vi.fn();
const requireProjectActionSpy = vi.fn();

vi.mock("@/lib/authz", () => ({
  requireActiveSession: (...a: unknown[]) => requireActiveSessionSpy(...a),
  requireProjectAction: (...a: unknown[]) => requireProjectActionSpy(...a),
}));

const dbRows: {
  run: Record<string, unknown> | null;
  hitl: Record<string, unknown> | null;
} = { run: null, hitl: null };
let selectSeq = 0;

// loadRunAndHitl issues exactly two selects per request: runs, hitl_requests.
vi.mock("@/lib/db/client", () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({
        where: async () => {
          selectSeq += 1;

          if (selectSeq % 2 === 1) return dbRows.run ? [dbRows.run] : [];

          return dbRows.hitl ? [dbRows.hitl] : [];
        },
      }),
    }),
  }),
}));

// M42 (ADR-114): the GET handler reads the resume handle from the run's active
// run_sessions row; derive it from the single run fixture.
vi.mock("@/lib/runs/active-run-session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/runs/active-run-session")>()),
  loadActiveRunSession: vi.fn(async () =>
    dbRows.run
      ? {
          sessionName: "default",
          acpSessionId: (dbRows.run.acpSessionId ?? null) as string | null,
          runnerSnapshot: (dbRows.run.runnerSnapshot ?? null) as never,
          capabilityAgent: (dbRows.run.capabilityAgent ?? null) as
            | string
            | null,
          runnerId: (dbRows.run.runnerId ?? null) as string | null,
          runnerResolutionTier: (dbRows.run.runnerResolutionTier ?? null) as
            | string
            | null,
        }
      : null,
  ),
}));

const availabilitySpy = vi.fn();
const listMessagesSpy = vi.fn();
const sendTurnSpy = vi.fn();

vi.mock("@/lib/services/gate-chat", () => ({
  gateChatAvailability: (...a: unknown[]) => availabilitySpy(...a),
  listGateChatMessages: (...a: unknown[]) => listMessagesSpy(...a),
  sendGateChatTurn: (...a: unknown[]) => sendTurnSpy(...a),
}));

function routeParams() {
  return { params: Promise.resolve({ runId: "r1", hitlRequestId: "h1" }) };
}

function getReq(): NextRequest {
  return new NextRequest("http://localhost/api/runs/r1/hitl/h1/chat");
}

function postReq(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/runs/r1/hitl/h1/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const sampleMessage = {
  id: "m1",
  role: "user",
  authorLabel: "u",
  body: "q",
  seq: 1,
  mutationReverted: false,
  createdAt: new Date("2026-01-01T00:00:00Z"),
};

beforeEach(() => {
  selectSeq = 0;
  requireActiveSessionSpy
    .mockReset()
    .mockResolvedValue({ id: "u1", name: "User One", email: "u1@x.local" });
  requireProjectActionSpy
    .mockReset()
    .mockResolvedValue({ user: { id: "u1" }, role: "member" });
  availabilitySpy.mockReset().mockReturnValue({ available: true });
  listMessagesSpy.mockReset().mockResolvedValue([]);
  sendTurnSpy.mockReset();
  dbRows.run = {
    id: "r1",
    projectId: "p1",
    status: "NeedsInputIdle",
    acpSessionId: "acp-1",
  };
  dbRows.hitl = { id: "h1", runId: "r1", kind: "human", respondedAt: null };
});

describe("GET /api/runs/{runId}/hitl/{hitlRequestId}/chat", () => {
  it("returns the implemented 200 envelope", async () => {
    listMessagesSpy.mockResolvedValue([sampleMessage]);

    const res = await GET(getReq(), routeParams());

    expect(res.status).toBe(200);

    const body = await res.json();

    expect(Object.keys(body).sort()).toEqual([
      "availability",
      "hitlRequestId",
      "idleResumeCost",
      "messages",
      "runId",
    ]);
    expect(body.runId).toBe("r1");
    expect(body.hitlRequestId).toBe("h1");
    expect(body.availability).toEqual({ available: true });
    expect(body.idleResumeCost).toBe(true);
    expect(body.messages).toHaveLength(1);
  });

  it("idleResumeCost is false when the pause is live (NeedsInput)", async () => {
    dbRows.run = { ...dbRows.run!, status: "NeedsInput" };

    const res = await GET(getReq(), routeParams());

    expect((await res.json()).idleResumeCost).toBe(false);
  });

  it("passes the availability DTO through verbatim", async () => {
    availabilitySpy.mockReturnValue({
      available: false,
      reason: "the pause already resolved",
    });

    const body = await (await GET(getReq(), routeParams())).json();

    expect(body.availability).toEqual({
      available: false,
      reason: "the pause already resolved",
    });
  });

  it("authorizes with answerHitl (member+), never readBoard — a viewer gets 403 and no transcript", async () => {
    requireProjectActionSpy.mockRejectedValue(
      new MaisterError("UNAUTHORIZED", "project role viewer below member"),
    );

    const res = await GET(getReq(), routeParams());

    expect(requireProjectActionSpy).toHaveBeenCalledWith("p1", "answerHitl");
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("UNAUTHORIZED");
    expect(listMessagesSpy).not.toHaveBeenCalled();
  });

  it("404 when the run is missing or the hitl row belongs to another run", async () => {
    dbRows.hitl = { ...dbRows.hitl!, runId: "other-run" };

    expect((await GET(getReq(), routeParams())).status).toBe(404);

    selectSeq = 0;
    dbRows.run = null;
    dbRows.hitl = { id: "h1", runId: "r1", kind: "human", respondedAt: null };

    expect((await GET(getReq(), routeParams())).status).toBe(404);
  });
});

describe("POST /api/runs/{runId}/hitl/{hitlRequestId}/chat", () => {
  it("returns the synchronous 200 envelope (not 202 {ok, seq})", async () => {
    sendTurnSpy.mockResolvedValue({
      userMessage: sampleMessage,
      agentMessage: { ...sampleMessage, id: "m2", role: "agent", seq: 2 },
      resumed: true,
    });

    const res = await POST(postReq({ message: "why?" }), routeParams());

    expect(res.status).toBe(200);

    const body = await res.json();

    expect(Object.keys(body).sort()).toEqual([
      "agentMessage",
      "hitlRequestId",
      "resumed",
      "runId",
      "userMessage",
    ]);
    expect(body.resumed).toBe(true);
    expect(requireProjectActionSpy).toHaveBeenCalledWith("p1", "answerHitl");
    expect(sendTurnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "r1",
        hitlRequestId: "h1",
        message: "why?",
        actorUserId: "u1",
        actorLabel: "User One",
      }),
    );
  });

  it("maps a malformed body to 400 CONFIG", async () => {
    const res = await POST(postReq({}), routeParams());

    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("CONFIG");
    expect(sendTurnSpy).not.toHaveBeenCalled();
  });

  it.each([
    ["PRECONDITION", 409],
    ["CONFLICT", 409],
    ["CHECKPOINT", 502],
    ["ACP_PROTOCOL", 502],
  ] as const)("maps service %s to HTTP %i", async (code, status) => {
    sendTurnSpy.mockRejectedValue(new MaisterError(code, "boom"));

    const res = await POST(postReq({ message: "q" }), routeParams());

    expect(res.status).toBe(status);
    expect((await res.json()).code).toBe(code);
  });

  it("404 when the hitl row belongs to another run", async () => {
    dbRows.hitl = { ...dbRows.hitl!, runId: "other-run" };

    const res = await POST(postReq({ message: "q" }), routeParams());

    expect(res.status).toBe(404);
    expect(sendTurnSpy).not.toHaveBeenCalled();
  });
});
