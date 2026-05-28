import type { FlowContext } from "@/lib/flows/types";
import type { PromptResult, SupervisorEvent } from "@/lib/supervisor-client";

import { describe, expect, it, vi } from "vitest";

import {
  runAgentStep,
  type RunAgentStepCtx,
  type SupervisorApi,
} from "@/lib/flows/runner-agent";

const baseFlowCtx: FlowContext = {
  task: { id: "t1", title: "T", prompt: "go", attemptNumber: 1 },
  run: { id: "run-1", attemptNumber: 1, projectSlug: "demo" },
  executor: { id: "e1", agent: "claude", model: "claude-sonnet-4-6" },
  steps: {},
  env: {},
};

function makeCtx(
  db: unknown,
  overrides: Partial<RunAgentStepCtx> = {},
): RunAgentStepCtx {
  return {
    runtimeRoot: "/tmp",
    projectSlug: "demo",
    runId: "run-1",
    stepId: "plan",
    worktreePath: "/tmp/wt",
    executor: { id: "e1", agent: "claude", model: "claude-sonnet-4-6" },
    context: baseFlowCtx,
    sessionState: { currentSessionId: null, lastSeenMonotonicId: 0 },
    db,
    ...overrides,
  };
}

type InsertSpy = {
  insertCalls: Array<Record<string, unknown>>;
  updates: Array<{ set: Record<string, unknown> }>;
  insertFails: boolean;
};

function makeFakeDb(opts: { insertFails?: boolean } = {}): InsertSpy & {
  insert: (...args: unknown[]) => unknown;
  update: (...args: unknown[]) => unknown;
  transaction: (fn: (tx: unknown) => Promise<void>) => Promise<void>;
} {
  const state: InsertSpy = {
    insertCalls: [],
    updates: [],
    insertFails: Boolean(opts.insertFails),
  };
  const insertChain = () => ({
    values: async (row: Record<string, unknown>) => {
      if (state.insertFails) {
        throw new Error("simulated INSERT failure");
      }
      state.insertCalls.push(row);
    },
  });
  const updateChain = () => ({
    set: (vals: Record<string, unknown>) => ({
      where: async () => {
        state.updates.push({ set: vals });
      },
    }),
  });

  return {
    ...state,
    insert: insertChain,
    update: updateChain,
    transaction: async (fn) => {
      await fn({
        insert: insertChain,
        update: updateChain,
      });
    },
  };
}

async function* eventStream(
  events: SupervisorEvent[],
): AsyncGenerator<SupervisorEvent> {
  for (const ev of events) {
    yield ev;
    await new Promise((r) => setImmediate(r));
  }
}

function makeApi(opts: {
  events: SupervisorEvent[];
  promptStopReason?: PromptResult["stopReason"];
  cancelImpl?: (
    sessionId: string,
    requestId: string,
    reason: string,
  ) => Promise<{ ok: true }>;
}): SupervisorApi & { cancelSpy: ReturnType<typeof vi.fn> } {
  const cancelSpy = vi.fn(
    opts.cancelImpl ?? (async () => ({ ok: true }) as { ok: true }),
  );

  return {
    createSession: vi.fn(async () => ({
      sessionId: "sup-session-1",
      pid: 1234,
      acpSessionId: "acp-1",
    })),
    deleteSession: vi.fn(async () => undefined),
    sendPrompt: vi.fn(async () => ({
      stopReason: opts.promptStopReason ?? "end_turn",
    })),
    streamSession: vi.fn(() =>
      eventStream(opts.events),
    ) as unknown as SupervisorApi["streamSession"],
    cancelPermission: cancelSpy as unknown as SupervisorApi["cancelPermission"],
    cancelSpy,
  };
}

function permissionRequest(
  monotonicId: number,
  requestId: string,
): SupervisorEvent {
  return {
    type: "session.permission_request",
    sessionId: "sup-session-1",
    monotonicId,
    requestId,
    options: [
      { optionId: "allow", kind: "allow_always", name: "Allow" },
      { optionId: "deny", kind: "reject_once", name: "Deny" },
    ],
    toolCall: { toolCallId: "tc-1", title: "Edit", kind: "execute" },
  };
}

function update(monotonicId: number, text: string): SupervisorEvent {
  return {
    type: "session.update",
    sessionId: "sup-session-1",
    monotonicId,
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text },
    },
  };
}

function exited(monotonicId: number): SupervisorEvent {
  return {
    type: "session.exited",
    sessionId: "sup-session-1",
    monotonicId,
    exitCode: 0,
  };
}

describe("runner-agent — session.permission_request handling", () => {
  it("inserts hitl_requests row + UPDATEs runs to NeedsInput on happy path", async () => {
    const db = makeFakeDb();
    const api = makeApi({
      events: [permissionRequest(1, "req-A"), update(2, "ok"), exited(3)],
    });

    await runAgentStep(
      {
        id: "plan",
        type: "agent",
        mode: "new-session",
        prompt: "go",
      },
      makeCtx(db),
      api,
    );

    expect(db.insertCalls).toHaveLength(1);
    const inserted = db.insertCalls[0];

    expect(inserted.kind).toBe("permission");
    expect(inserted.runId).toBe("run-1");
    expect(inserted.stepId).toBe("plan");
    expect((inserted.schema as { requestId: string }).requestId).toBe("req-A");
    expect(
      (inserted.schema as { supervisorSessionId: string }).supervisorSessionId,
    ).toBe("sup-session-1");

    const statusUpdates = db.updates.map((u) => u.set.status).filter(Boolean);

    expect(statusUpdates).toContain("NeedsInput");
    expect(statusUpdates).toContain("Running");
  });

  it("two permission_requests for the same step produce two hitl_requests rows", async () => {
    const db = makeFakeDb();
    const api = makeApi({
      events: [
        permissionRequest(1, "req-1"),
        update(2, "chunk1"),
        permissionRequest(3, "req-2"),
        update(4, "chunk2"),
        exited(5),
      ],
    });

    await runAgentStep(
      { id: "plan", type: "agent", mode: "new-session", prompt: "go" },
      makeCtx(db),
      api,
    );

    expect(db.insertCalls).toHaveLength(2);
    expect((db.insertCalls[0].schema as { requestId: string }).requestId).toBe(
      "req-1",
    );
    expect((db.insertCalls[1].schema as { requestId: string }).requestId).toBe(
      "req-2",
    );
  });

  it("cancels supervisor deferred + transitions run to Crashed AND returns ok=false errorCode=CRASH when INSERT fails", async () => {
    const db = makeFakeDb({ insertFails: true });
    const api = makeApi({
      events: [permissionRequest(1, "req-fail"), update(2, "tail"), exited(3)],
    });

    const result = await runAgentStep(
      { id: "plan", type: "agent", mode: "new-session", prompt: "go" },
      makeCtx(db),
      api,
    );

    expect(api.cancelSpy).toHaveBeenCalledTimes(1);
    expect(api.cancelSpy).toHaveBeenCalledWith(
      "sup-session-1",
      "req-fail",
      expect.stringContaining("DB_PERSIST_FAILED"),
    );

    const statusUpdates = db.updates.map((u) => u.set.status).filter(Boolean);

    expect(statusUpdates).toContain("Crashed");
    // The crash signal must reach runFlow — otherwise the final Review
    // transition would overwrite the Crashed state.
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("CRASH");
  });

  it("keeps consuming the stream AND returns errorCode=CRASH when INSERT + cancelPermission both fail", async () => {
    const db = makeFakeDb({ insertFails: true });
    const api = makeApi({
      events: [permissionRequest(1, "req-X"), update(2, "tail"), exited(3)],
      cancelImpl: async () => {
        throw new Error("supervisor unreachable");
      },
    });

    const result = await runAgentStep(
      { id: "plan", type: "agent", mode: "new-session", prompt: "go" },
      makeCtx(db),
      api,
    );

    expect(api.cancelSpy).toHaveBeenCalledTimes(1);
    const statusUpdates = db.updates.map((u) => u.set.status).filter(Boolean);

    expect(statusUpdates).toContain("Crashed");
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("CRASH");
  });

  it("no-hidden-deferred regression: cancelPermission called exactly once with the matching (sessionId, requestId)", async () => {
    const db = makeFakeDb({ insertFails: true });
    const api = makeApi({
      events: [permissionRequest(1, "req-spy"), exited(2)],
    });

    await runAgentStep(
      { id: "plan", type: "agent", mode: "new-session", prompt: "go" },
      makeCtx(db),
      api,
    );

    expect(api.cancelSpy).toHaveBeenCalledTimes(1);
    expect(api.cancelSpy.mock.calls[0][0]).toBe("sup-session-1");
    expect(api.cancelSpy.mock.calls[0][1]).toBe("req-spy");
  });

  it("event consumer captures session.update text chunks after permission_request resolves", async () => {
    const db = makeFakeDb();
    const api = makeApi({
      events: [
        permissionRequest(1, "req-after"),
        update(2, "post-permission chunk"),
        exited(3),
      ],
    });

    const result = await runAgentStep(
      { id: "plan", type: "agent", mode: "new-session", prompt: "go" },
      makeCtx(db),
      api,
    );

    expect(result.stdout).toContain("post-permission chunk");
  });
});
