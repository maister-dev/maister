// Phase 3 (ADR-108 / M40) — the flow consumer's session.hook_trip handling.
// A halting trip (repetition / no_progress) escalates via escalateHookTrip and
// surfaces STEP_CHECKPOINTED WITHOUT markCheckpointedFromExit (so the run stays
// NeedsInput, not NeedsInputIdle); a path_guard deny is record-only and the node
// completes normally. escalateHookTrip + markCheckpointedFromExit are mocked so
// this stays a pure wiring test (no DB).

import type { FlowContext } from "@/lib/flows/types";
import type { SupervisorEvent } from "@/lib/supervisor-client";

import { describe, expect, it, vi } from "vitest";

const escalateHookTripMock = vi.hoisted(() => ({
  escalateHookTrip: vi.fn(async () => ({ escalated: true })),
}));

vi.mock("@/lib/runs/hook-trip", () => escalateHookTripMock);

const stateTransitionsMock = vi.hoisted(() => ({
  markCheckpointedFromExit: vi.fn(async () => ({ ok: true as const })),
}));

vi.mock("@/lib/runs/state-transitions", () => stateTransitionsMock);

import { MaisterError } from "@/lib/errors";
import { runAgentStep, type RunAgentStepCtx } from "@/lib/flows/runner-agent";

const baseFlowCtx: FlowContext = {
  task: { id: "t1", title: "T", prompt: "go", attemptNumber: 1 },
  run: { id: "run-1", attemptNumber: 1, projectSlug: "demo" },
  executor: { id: "e1", agent: "claude", model: "claude-sonnet-4-6" },
  steps: {},
  env: {},
  artifacts: {},
};

function makeCtx(overrides: Partial<RunAgentStepCtx> = {}): RunAgentStepCtx {
  return {
    runtimeRoot: "/tmp",
    projectSlug: "demo",
    runId: "run-1",
    stepId: "implement",
    worktreePath: "/tmp/wt",
    executor: { id: "e1", agent: "claude", model: "claude-sonnet-4-6" },
    context: baseFlowCtx,
    sessionState: { currentSessionId: null, lastSeenMonotonicId: 0 },
    db: makeFakeDb(),
    ...overrides,
  };
}

// Minimal no-op fake DB — the hook path with no nodeAttemptId persists nothing;
// escalateHookTrip (mocked) never touches it.
function makeFakeDb(): any {
  const thenable = (rows: unknown[]) => {
    const r: any = Promise.resolve(rows);

    r.returning = async () => rows;
    r.limit = async () => rows;

    return r;
  };

  const api: any = {
    insert: () => ({ values: () => thenable([]) }),
    update: () => ({ set: () => ({ where: () => thenable([{ id: "x" }]) }) }),
    select: () => ({ from: () => ({ where: () => thenable([]) }) }),
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(api),
  };

  return api;
}

async function* eventStream(
  events: SupervisorEvent[],
): AsyncGenerator<SupervisorEvent> {
  for (const ev of events) {
    yield ev;
    await new Promise((r) => setImmediate(r));
  }
}

function makeApi(events: SupervisorEvent[]) {
  const checkpointSpy = vi.fn(async () => ({
    alreadyCheckpointed: false,
    sessionId: "s",
    monotonicId: 0,
  }));

  return {
    createSession: vi.fn(async () => ({
      sessionId: "sup-session-1",
      pid: 1234,
      acpSessionId: "acp-1",
    })),
    deleteSession: vi.fn(async () => undefined),
    sendPrompt: vi.fn(async () => ({ stopReason: "end_turn" as const })),
    streamSession: vi.fn(() => eventStream(events)) as any,
    cancelPermission: vi.fn(async () => ({ ok: true as const })) as any,
    deliverPermission: vi.fn(async () => ({ ok: true as const })) as any,
    checkpointSession: checkpointSpy as any,
    checkpointSpy,
  };
}

function hookTrip(
  monotonicId: number,
  disposition: "deny" | "halt",
  rule: "path_guard" | "repetition" | "no_progress",
): SupervisorEvent {
  return {
    type: "session.hook_trip",
    sessionId: "sup-session-1",
    monotonicId,
    rule,
    lifecycle: rule === "no_progress" ? "post_turn" : "pre_tool_call",
    disposition,
    toolCall: { toolCallId: "tc-1", title: "Edit src/x.ts", kind: "edit" },
  };
}

function exited(monotonicId: number, reason?: "checkpoint"): SupervisorEvent {
  return {
    type: "session.exited",
    sessionId: "sup-session-1",
    monotonicId,
    exitCode: 0,
    ...(reason ? { reason } : {}),
  };
}

describe("runner-agent — session.hook_trip", () => {
  it("halt: escalates and surfaces STEP_CHECKPOINTED without markCheckpointedFromExit", async () => {
    escalateHookTripMock.escalateHookTrip.mockClear();
    stateTransitionsMock.markCheckpointedFromExit.mockClear();
    const api = makeApi([
      hookTrip(1, "halt", "repetition"),
      exited(2, "checkpoint"),
    ]);

    const result = await runAgentStep(
      { id: "implement", type: "agent", mode: "new-session", prompt: "go" },
      makeCtx(),
      api as never,
    );

    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("STEP_CHECKPOINTED");
    expect(escalateHookTripMock.escalateHookTrip).toHaveBeenCalledTimes(1);
    expect(escalateHookTripMock.escalateHookTrip).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-1",
        stepId: "implement",
        rule: "repetition",
        runKind: "flow",
        supervisorSessionId: "sup-session-1",
      }),
    );
    // The escalate already left the run NeedsInput — the idle flip must NOT fire.
    expect(
      stateTransitionsMock.markCheckpointedFromExit,
    ).not.toHaveBeenCalled();
  });

  it("escalate rejection: surfaces CRASH (not a clean checkpoint), no markCheckpointedFromExit", async () => {
    escalateHookTripMock.escalateHookTrip.mockClear();
    stateTransitionsMock.markCheckpointedFromExit.mockClear();
    // The escalate tx throws AFTER the pre-tx checkpoint already stopped the
    // agent — the run is stranded Running with no hook_trip HITL.
    escalateHookTripMock.escalateHookTrip.mockRejectedValueOnce(
      new Error("escalate tx threw"),
    );
    const api = makeApi([
      hookTrip(1, "halt", "repetition"),
      exited(2, "checkpoint"),
    ]);

    const result = await runAgentStep(
      { id: "implement", type: "agent", mode: "new-session", prompt: "go" },
      makeCtx(),
      api as never,
    );

    expect(result.ok).toBe(false);
    // CRASH (runFlow → Crashed → recover), NOT the false clean STEP_CHECKPOINTED
    // that would hide the stranded run behind a successful pause.
    expect(result.errorCode).toBe("CRASH");
    expect(
      stateTransitionsMock.markCheckpointedFromExit,
    ).not.toHaveBeenCalled();
  });

  it("escalate EXECUTOR_UNAVAILABLE: live halt undeliverable → surfaces CRASH", async () => {
    escalateHookTripMock.escalateHookTrip.mockClear();
    stateTransitionsMock.markCheckpointedFromExit.mockClear();
    // The pre-tx checkpoint returned EXECUTOR_UNAVAILABLE — the supervisor halted
    // the agent and will not re-emit; the run is stranded Running with no HITL.
    escalateHookTripMock.escalateHookTrip.mockRejectedValueOnce(
      new MaisterError("EXECUTOR_UNAVAILABLE", "supervisor 503"),
    );
    const api = makeApi([hookTrip(1, "halt", "repetition")]);

    const result = await runAgentStep(
      { id: "implement", type: "agent", mode: "new-session", prompt: "go" },
      makeCtx(),
      api as never,
    );

    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("CRASH");
    expect(
      stateTransitionsMock.markCheckpointedFromExit,
    ).not.toHaveBeenCalled();
  });

  it("no_progress halt is escalated with the no_progress rule", async () => {
    escalateHookTripMock.escalateHookTrip.mockClear();
    const api = makeApi([
      hookTrip(1, "halt", "no_progress"),
      exited(2, "checkpoint"),
    ]);

    const result = await runAgentStep(
      { id: "implement", type: "agent", mode: "new-session", prompt: "go" },
      makeCtx(),
      api as never,
    );

    expect(result.errorCode).toBe("STEP_CHECKPOINTED");
    expect(escalateHookTripMock.escalateHookTrip).toHaveBeenCalledWith(
      expect.objectContaining({ rule: "no_progress" }),
    );
  });

  it("deny: record-only — no escalate, node completes normally", async () => {
    escalateHookTripMock.escalateHookTrip.mockClear();
    const api = makeApi([hookTrip(1, "deny", "path_guard"), exited(2)]);

    const result = await runAgentStep(
      { id: "implement", type: "agent", mode: "new-session", prompt: "go" },
      makeCtx(),
      api as never,
    );

    expect(escalateHookTripMock.escalateHookTrip).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
  });
});
