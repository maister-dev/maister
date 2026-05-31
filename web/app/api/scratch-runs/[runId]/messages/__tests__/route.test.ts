import type { NextRequest } from "next/server";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireActiveSession: vi.fn(),
  requireProjectAction: vi.fn(),
  sendScratchPromptAndProjectEvents: vi.fn(),
  sendPrompt: vi.fn(),
}));

type FakeDb = {
  select: (fields?: unknown) => {
    from: (table: unknown) => {
      where: (predicate: unknown) => Promise<Record<string, unknown>[]>;
    };
  };
  insert: (table: unknown) => {
    values: (values: unknown) => Promise<void>;
  };
  update: (table: unknown) => {
    set: (values: unknown) => {
      where: (predicate: unknown) => Promise<void>;
    };
  };
  transaction: <T>(fn: (tx: FakeDb) => Promise<T>) => Promise<T>;
};

const runId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const state: {
  selectCalls: number;
  scratchStatus: string;
  inserts: unknown[];
  updates: unknown[];
} = {
  selectCalls: 0,
  scratchStatus: "WaitingForUser",
  inserts: [],
  updates: [],
};

const fakeDb: FakeDb = {
  select: () => ({
    from: () => ({
      where: async () => {
        state.selectCalls += 1;

        if (state.selectCalls === 1 || state.selectCalls === 2) {
          return [
            { id: runId, runKind: "scratch", projectId, status: "Running" },
          ];
        }
        if (state.selectCalls === 3 || state.selectCalls === 6) {
          return [
            {
              runId,
              dialogStatus:
                state.selectCalls === 6 ? "Running" : state.scratchStatus,
              supervisorSessionId: "supervisor-session-1",
            },
          ];
        }
        if (state.selectCalls === 4) {
          return [
            {
              runId,
              parentRepoPath: "/repos/demo",
              worktreePath: "/tmp/worktrees/demo/run",
            },
          ];
        }
        if (state.selectCalls === 5) {
          return [{ sequence: 1 }, { sequence: 2 }];
        }

        return [];
      },
    }),
  }),
  insert: () => ({
    values: async (values: unknown) => {
      state.inserts.push(values);
    },
  }),
  update: () => ({
    set: (values: unknown) => ({
      where: async () => {
        state.updates.push(values);
      },
    }),
  }),
  transaction: async <T>(fn: (tx: FakeDb) => Promise<T>) => fn(fakeDb),
};

vi.mock("@/lib/authz", () => ({
  requireActiveSession: mocks.requireActiveSession,
  requireProjectAction: mocks.requireProjectAction,
}));
vi.mock("@/lib/db/client", () => ({ getDb: () => fakeDb }));
vi.mock("@/lib/supervisor-client", () => ({
  sendPrompt: mocks.sendPrompt,
}));
vi.mock("@/lib/scratch-runs/events", () => ({
  sendScratchPromptAndProjectEvents: mocks.sendScratchPromptAndProjectEvents,
}));

let POST: (
  req: NextRequest,
  ctx: { params: Promise<{ runId: string }> },
) => Promise<Response>;

beforeEach(async () => {
  state.selectCalls = 0;
  state.scratchStatus = "WaitingForUser";
  state.inserts = [];
  state.updates = [];
  mocks.requireActiveSession.mockResolvedValue({ id: "user-1" });
  mocks.requireProjectAction.mockResolvedValue({ role: "member" });
  mocks.sendPrompt.mockResolvedValue({ stopReason: "end_turn" });
  mocks.sendScratchPromptAndProjectEvents.mockResolvedValue({
    stopReason: "end_turn",
  });

  ({ POST } = await import("../route"));
});

afterEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

function request(content = "Continue"): NextRequest {
  return new Request("http://x/api/scratch-runs/run/messages", {
    method: "POST",
    body: JSON.stringify({ content, attachments: [] }),
  }) as NextRequest;
}

function ctx() {
  return { params: Promise.resolve({ runId }) };
}

describe("POST /api/scratch-runs/[runId]/messages", () => {
  it("appends the next user message and sends a supervisor prompt", async () => {
    const res = await POST(request("Continue please"), ctx());
    const body = (await res.json()) as {
      ok?: boolean;
      sequence?: number;
      dialogStatus?: string;
    };

    expect(res.status).toBe(202);
    expect(body.ok).toBe(true);
    expect(body.sequence).toBe(3);
    expect(body.dialogStatus).toBe("WaitingForUser");
    expect(state.inserts[0]).toEqual(
      expect.objectContaining({
        runId,
        sequence: 3,
        role: "user",
        content: "Continue please",
      }),
    );
    expect(mocks.sendScratchPromptAndProjectEvents).toHaveBeenCalledWith({
      runId,
      sessionId: "supervisor-session-1",
      stepId: "dialog",
      prompt: "Continue please",
    });
  });

  it("rejects while a scratch prompt is already running", async () => {
    state.scratchStatus = "Running";

    const res = await POST(request(), ctx());
    const body = (await res.json()) as { code?: string };

    expect(res.status).toBe(409);
    expect(body.code).toBe("CONFLICT");
    expect(state.inserts).toHaveLength(0);
    expect(mocks.sendScratchPromptAndProjectEvents).not.toHaveBeenCalled();
  });

  it("leaves the dialog retryable when supervisor prompt delivery fails", async () => {
    const { MaisterError: CurrentMaisterError } = await import("@/lib/errors");

    mocks.sendScratchPromptAndProjectEvents.mockRejectedValueOnce(
      new CurrentMaisterError("EXECUTOR_UNAVAILABLE", "supervisor unavailable"),
    );

    const res = await POST(request("Retryable prompt"), ctx());
    const body = (await res.json()) as { code?: string };

    expect(res.status).toBe(503);
    expect(body.code).toBe("EXECUTOR_UNAVAILABLE");
    expect(state.inserts[0]).toEqual(
      expect.objectContaining({
        runId,
        sequence: 3,
        role: "user",
        content: "Retryable prompt",
      }),
    );
    expect(state.updates).toContainEqual(
      expect.objectContaining({
        dialogStatus: "WaitingForUser",
        errorCode: "EXECUTOR_UNAVAILABLE",
      }),
    );
    expect(state.updates).not.toContainEqual(
      expect.objectContaining({ dialogStatus: "Crashed" }),
    );
  });
});
