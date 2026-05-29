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

function makeFakeDb(
  opts: {
    insertFails?: boolean;
    priorIntent?: Record<string, unknown> | null;
  } = {},
): InsertSpy & {
  insert: (...args: unknown[]) => unknown;
  update: (...args: unknown[]) => unknown;
  select: (...args: unknown[]) => unknown;
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
      where: (..._args: unknown[]) => {
        state.updates.push({ set: vals });
        // Thenable that also exposes .returning() so callers that
        // either `await db.update(t).set(...).where(...)` or
        // `db.update(t).set(...).where(...).returning(...)` both work.
        const result: any = Promise.resolve([{ id: "x" }]);

        result.returning = async () => [{ id: "x" }];

        return result;
      },
    }),
  });
  // M8 T11: tryAutoDeliverStoredIntent reads hitl_requests for a prior
  // stored intent. Tests without `priorIntent` get an empty result so
  // the legacy "INSERT new row" path still fires.
  const selectChain = () => ({
    from: () => ({
      where: () => ({
        limit: async () => (opts.priorIntent ? [opts.priorIntent] : []),
      }),
    }),
  });

  return {
    ...state,
    insert: insertChain,
    update: updateChain,
    select: selectChain,
    transaction: async (fn) => {
      await fn({
        insert: insertChain,
        update: updateChain,
        select: selectChain,
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
    deliverPermission: vi.fn(
      async () => ({ ok: true }) as { ok: true },
    ) as unknown as SupervisorApi["deliverPermission"],
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

function checkpointExited(monotonicId: number): SupervisorEvent {
  return {
    type: "session.exited",
    sessionId: "sup-session-1",
    monotonicId,
    exitCode: 0,
    reason: "checkpoint",
  };
}

function intentionalExited(monotonicId: number): SupervisorEvent {
  return {
    type: "session.exited",
    sessionId: "sup-session-1",
    monotonicId,
    exitCode: 0,
    reason: "intentional",
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

// M8 Codex review fix #1: when the supervisor checkpoints the agent
// mid-permission, the adapter cancels the pending requestPermission with
// `{outcome: "cancelled"}` and the prompt returns with
// `stopReason: "end_turn"` (the cancelled permission is journaled for
// replay on --resume, not denied). The runner-agent MUST inspect
// `session.exited.reason` and suppress step success even when the
// stopReason looks successful.
describe("runner-agent — session.exited.reason handling (M8 Codex fix #1)", () => {
  it("session.exited.reason='checkpoint' suppresses success and returns STEP_CHECKPOINTED", async () => {
    const db = makeFakeDb();
    const api = makeApi({
      events: [permissionRequest(1, "req-cp"), checkpointExited(2)],
      promptStopReason: "end_turn",
    });

    const result = await runAgentStep(
      { id: "plan", type: "agent", mode: "new-session", prompt: "go" },
      makeCtx(db),
      api,
    );

    // Step is paused, not succeeded — even though stopReason says end_turn.
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("STEP_CHECKPOINTED");

    // markCheckpointedFromExit must have fired — confirmed by an UPDATE
    // setting status to NeedsInputIdle (with checkpointAt + null keepalive).
    const statusUpdates = db.updates.map((u) => u.set.status).filter(Boolean);

    expect(statusUpdates).toContain("NeedsInputIdle");
    const idleUpdate = db.updates.find(
      (u) => u.set.status === "NeedsInputIdle",
    );

    expect(idleUpdate).toBeDefined();
    expect(idleUpdate?.set.keepaliveUntil).toBeNull();
  });

  it("session.exited with no reason still treats end_turn as success (regression guard)", async () => {
    const db = makeFakeDb();
    const api = makeApi({
      events: [update(1, "hello"), exited(2)],
      promptStopReason: "end_turn",
    });

    const result = await runAgentStep(
      { id: "plan", type: "agent", mode: "new-session", prompt: "go" },
      makeCtx(db),
      api,
    );

    expect(result.ok).toBe(true);
    expect(result.errorCode).toBeUndefined();

    const statusUpdates = db.updates.map((u) => u.set.status).filter(Boolean);

    expect(statusUpdates).not.toContain("NeedsInputIdle");
  });

  it("session.exited.reason='intentional' does NOT trigger STEP_CHECKPOINTED (only checkpoint reason should)", async () => {
    const db = makeFakeDb();
    const api = makeApi({
      events: [update(1, "hi"), intentionalExited(2)],
      promptStopReason: "end_turn",
    });

    const result = await runAgentStep(
      { id: "plan", type: "agent", mode: "new-session", prompt: "go" },
      makeCtx(db),
      api,
    );

    expect(result.ok).toBe(true);
    expect(result.errorCode).toBeUndefined();
  });

  it("checkpoint reason on slash-in-existing also returns STEP_CHECKPOINTED", async () => {
    const db = makeFakeDb();
    const api = makeApi({
      events: [permissionRequest(1, "req-cp-slash"), checkpointExited(2)],
      promptStopReason: "end_turn",
    });

    const ctx = makeCtx(db, {
      sessionState: {
        currentSessionId: "sup-session-1",
        lastSeenMonotonicId: 0,
      },
    });
    const result = await runAgentStep(
      { id: "plan", type: "agent", mode: "slash-in-existing", prompt: "go" },
      ctx,
      api,
    );

    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("STEP_CHECKPOINTED");
  });
});
