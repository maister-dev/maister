// M8 review pass 2 finding #2 + #3 regression coverage for the
// resume driver:
//   * #2: retryable EXECUTOR_UNAVAILABLE prompt failure MUST NOT
//     close the stored intent (no markIntentAbandoned) and MUST roll
//     the run back to NeedsInputIdle so the next /respond retry can
//     re-resume.
//   * #3: on the happy path the driver records the node attempt and lets the
//     graph runner continue from its success edge.

import { beforeEach, describe, expect, it, vi } from "vitest";

import { MaisterError } from "@/lib/errors";

const sendPromptSpy = vi.fn();
const streamSessionSpy = vi.fn();
const deliverPermissionSpy = vi.fn();
const cancelPermissionSpy = vi.fn();
const deleteSessionSpy = vi.fn();

vi.mock("@/lib/supervisor-client", () => ({}));

// ADR-166: the resumed-session driver talks to the host through the client
// bound to the run's assignment (prompt / input / delete) and the host-scoped
// admin stream. The fake client routes each call to the existing spies with
// the legacy argument shapes the cases assert on.
const fakeBoundClient = () => ({
  prompt: async (sessionId: string, input: unknown) => ({
    commandId: "cmd",
    completion: sendPromptSpy(sessionId, input),
  }),
  waitForPrompt: (handle: { completion: Promise<unknown> }) =>
    handle.completion,
  deliverInput: (
    sessionId: string,
    payload: {
      action: "select" | "cancel";
      requestId: string;
      optionId?: string;
      reason?: string;
    },
  ) =>
    payload.action === "select"
      ? deliverPermissionSpy(sessionId, payload.requestId, payload.optionId)
      : cancelPermissionSpy(sessionId, payload.requestId, payload.reason),
  deleteSession: (sessionId: string) => deleteSessionSpy(sessionId),
});
const fakeAdmin = () => ({
  streamSession: (...args: unknown[]) =>
    streamSessionSpy(...(args as unknown[])),
});

vi.mock("@/lib/execution-host", () => ({
  isFencedError: (err: unknown) =>
    (err as { details?: { reason?: string } } | null)?.details?.reason ===
    "assignment_fenced",
  createExecutionHosts: () => ({
    transport: {},
    forRun: async () => fakeBoundClient(),
    forAssignment: () => {
      throw new Error("not used");
    },
    // The driver binds the generation its claim minted (or the run's active
    // pointer read at entry); the fake serves the same client either way.
    executionFor: async () => ({
      client: fakeBoundClient(),
      admin: fakeAdmin(),
    }),
    local: fakeAdmin,
  }),
}));

const stateTransitionSpies = vi.hoisted(() => ({
  rollbackResumedRunSpy: vi.fn(),
  crashResumedRunSpy: vi.fn(),
  failResumedRunSpy: vi.fn(),
}));

vi.mock("@/lib/runs/state-transitions", () => ({
  rollbackResumedRun: (...args: unknown[]) =>
    stateTransitionSpies.rollbackResumedRunSpy(...(args as unknown[])),
  crashResumedRun: (...args: unknown[]) =>
    stateTransitionSpies.crashResumedRunSpy(...(args as unknown[])),
  failResumedRun: (...args: unknown[]) =>
    stateTransitionSpies.failResumedRunSpy(...(args as unknown[])),
}));

const { rollbackResumedRunSpy, crashResumedRunSpy, failResumedRunSpy } =
  stateTransitionSpies;

const markNodeSucceededSpy = vi.fn();

vi.mock("@/lib/flows/graph/ledger", () => ({
  markNodeSucceeded: (...args: unknown[]) =>
    markNodeSucceededSpy(...(args as unknown[])),
}));

// runFlow continuation hook — spy to assert hand-off happens.
const runFlowSpy = vi.fn();

vi.mock("@/lib/flows/runner", () => ({
  runFlow: (...args: unknown[]) => runFlowSpy(...(args as unknown[])),
}));

// M8 Codex review fix #3: scheduler promotion on terminal transitions
// is dynamically imported inside the driver — vi.mock still intercepts
// dynamic imports.
const promoteNextPendingSpy = vi.fn();

vi.mock("@/lib/scheduler", () => ({
  promoteNextPending: (...args: unknown[]) =>
    promoteNextPendingSpy(...(args as unknown[])),
}));

vi.mock("@/lib/webhooks/outbox", () => ({
  emitWebhookEvent: vi.fn(async () => undefined),
}));

// Db chain mocks.
type Row = Record<string, unknown>;
const dbState: {
  hitlRow: Row | null;
  runRow: Row | null;
  runSession: Row | null;
  openNodeAttempt: Row | null;
  updateWhereCalls: number;
  updateReturningCount: number;
  hitlRespondedAt: Date | null;
  hitlResponse: Row | null;
} = {
  hitlRow: null,
  runRow: null,
  runSession: null,
  openNodeAttempt: null,
  updateWhereCalls: 0,
  updateReturningCount: 1,
  hitlRespondedAt: null,
  hitlResponse: null,
};

// Tagged schema mocks — the driver does `import * as schemaModule
// from "@/lib/db/schema"; const {hitlRequests, nodeAttempts, runs}
// = schemaModule as ...`. By mocking schemaModule we get to control
// what the driver sees, and the fake db chain can dispatch off the
// tag to return the right rows.
const TABLE_HITL = { _t: "hitl_requests" } as const;
const TABLE_RUNS = { _t: "runs" } as const;
const TABLE_NODE_ATTEMPTS = { _t: "node_attempts" } as const;
const TABLE_RUN_SESSIONS = {
  _t: "run_sessions",
  runId: { _t: "run_sessions.runId" },
  acpSessionId: { _t: "run_sessions.acpSessionId" },
  updatedAt: { _t: "run_sessions.updatedAt" },
} as const;

vi.mock("@/lib/db/schema", () => ({
  hitlRequests: TABLE_HITL,
  runs: TABLE_RUNS,
  nodeAttempts: TABLE_NODE_ATTEMPTS,
  runSessions: TABLE_RUN_SESSIONS,
}));

const selectChainFactory = () => {
  return {
    from: (table: unknown) => {
      const tableTag = (table as { _t?: string } | null)?._t;

      const resolveRows = (): Row[] => {
        if (tableTag === "hitl_requests") {
          return dbState.hitlRow ? [dbState.hitlRow] : [];
        }
        if (tableTag === "runs") {
          return dbState.runRow ? [dbState.runRow] : [];
        }
        if (tableTag === "run_sessions") {
          return dbState.runSession ? [dbState.runSession] : [];
        }
        if (tableTag === "node_attempts") {
          return dbState.openNodeAttempt ? [dbState.openNodeAttempt] : [];
        }

        return [];
      };

      return {
        where: () => {
          // We must support both `await chain.where(...)` AND
          // `chain.where(...).limit(N)`. To avoid Object.assign on a
          // Promise (which broke await propagation here), expose
          // explicit `.then` AND `.limit`. The `.then` follows the
          // PromiseLike contract: call onFulfilled with the value
          // and return undefined.
          const query = {
            then(
              onFulfilled: (rows: Row[]) => unknown,
              onRejected?: (err: unknown) => unknown,
            ) {
              try {
                const v = resolveRows();

                return Promise.resolve(onFulfilled(v));
              } catch (err) {
                if (onRejected) return Promise.resolve(onRejected(err));
                throw err;
              }
            },
            limit: async () => resolveRows(),
            orderBy: () => query,
          };

          return query;
        },
      };
    },
  };
};

const updateChain = () => ({
  set: (vals: Row) => ({
    where: () => ({
      returning: async () => {
        dbState.updateWhereCalls += 1;
        if ("respondedAt" in vals) {
          dbState.hitlRespondedAt = vals.respondedAt as Date | null;
        }
        if ("response" in vals) {
          dbState.hitlResponse = vals.response as Row | null;
        }

        return dbState.updateReturningCount > 0 ? [{ id: "id" }] : [];
      },
      async then(onFulfilled: (v: unknown) => unknown) {
        dbState.updateWhereCalls += 1;
        if ("respondedAt" in vals) {
          dbState.hitlRespondedAt = vals.respondedAt as Date | null;
        }
        if ("response" in vals) {
          dbState.hitlResponse = vals.response as Row | null;
        }

        return onFulfilled(undefined);
      },
    }),
  }),
});

// T7: emitWebhookEvent rides the same tx — no-op insert + pass-through tx so
// the hitl.responded capture in markIntentDelivered runs without a real DB.
const fakeDb: Record<string, unknown> = {
  select: () => selectChainFactory(),
  update: () => updateChain(),
  insert: () => ({ values: async () => undefined }),
  transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(fakeDb),
};

vi.mock("@/lib/db/client", () => ({ getDb: () => fakeDb }));

async function* asyncIter<T>(items: T[]): AsyncGenerator<T> {
  for (const it of items) yield it;
}

// Imported lazily AFTER vi.mock declarations have taken effect.
// Avoid vi.resetModules() between tests — that would create two
// copies of @/lib/errors, breaking `instanceof MaisterError` checks
// inside the driver (the test would throw a MaisterError from copy
// #1 while the driver's `isMaisterError` checks against copy #2).
let runResumedSession: (opts: {
  runId: string;
  supervisorSessionId: string;
  acpSessionId: string;
  stepId: string;
  db?: unknown;
}) => Promise<void>;

beforeEach(async () => {
  dbState.hitlRow = {
    id: "hitl-1",
    runId: "run-1",
    stepId: "review",
    kind: "permission",
    schema: { requestId: "req-original" },
    response: { optionId: "allow" },
    respondedAt: null,
  };
  dbState.runRow = {
    id: "run-1",
    flowId: "flow-1",
    currentStepId: "review",
    acpSessionId: "acp-1",
  };
  dbState.runSession = {
    sessionName: "default",
    acpSessionId: "acp-1",
    runnerSnapshot: null,
    capabilityAgent: "claude",
    runnerId: "runner-1",
    runnerResolutionTier: "projectDefault",
  };
  dbState.openNodeAttempt = { id: "node-attempt-1" };
  dbState.updateWhereCalls = 0;
  dbState.updateReturningCount = 1;
  dbState.hitlRespondedAt = null;
  dbState.hitlResponse = { optionId: "allow" };

  sendPromptSpy.mockReset();
  streamSessionSpy.mockReset();
  deliverPermissionSpy.mockReset();
  cancelPermissionSpy.mockReset();
  deleteSessionSpy.mockReset();
  rollbackResumedRunSpy.mockReset();
  crashResumedRunSpy.mockReset();
  failResumedRunSpy.mockReset();
  markNodeSucceededSpy.mockReset();
  runFlowSpy.mockReset();
  promoteNextPendingSpy.mockReset();
  promoteNextPendingSpy.mockResolvedValue({ promotedRunId: null });

  if (!runResumedSession) {
    ({ runResumedSession } = await import("../resume-driver"));
  }
});

describe("runResumedSession — [FIX-PASS2-F2] retryable prompt failure", () => {
  it("EXECUTOR_UNAVAILABLE prompt failure preserves stored intent and rolls back to NeedsInputIdle", async () => {
    streamSessionSpy.mockReturnValue(asyncIter([]));
    sendPromptSpy.mockRejectedValueOnce(
      new MaisterError("EXECUTOR_UNAVAILABLE", "supervisor 503"),
    );
    rollbackResumedRunSpy.mockResolvedValue({ ok: true });

    await runResumedSession({
      runId: "run-1",
      supervisorSessionId: "sup-2",
      acpSessionId: "acp-1",
      stepId: "review",
      db: fakeDb,
    });

    expect(rollbackResumedRunSpy).toHaveBeenCalledTimes(1);
    expect(crashResumedRunSpy).not.toHaveBeenCalled();
    expect(failResumedRunSpy).not.toHaveBeenCalled();
    // CRITICAL: hitl_requests.respondedAt must remain null so a
    // subsequent /respond retry sees the stored intent as pending.
    expect(dbState.hitlRespondedAt).toBeNull();
  });

  it("terminal prompt failure (non-EXECUTOR_UNAVAILABLE) abandons intent and crashes", async () => {
    streamSessionSpy.mockReturnValue(asyncIter([]));
    sendPromptSpy.mockRejectedValueOnce(
      new MaisterError("ACP_PROTOCOL", "bad message"),
    );
    crashResumedRunSpy.mockResolvedValue({ ok: true });

    await runResumedSession({
      runId: "run-1",
      supervisorSessionId: "sup-2",
      acpSessionId: "acp-1",
      stepId: "review",
      db: fakeDb,
    });

    expect(rollbackResumedRunSpy).not.toHaveBeenCalled();
    expect(crashResumedRunSpy).toHaveBeenCalledTimes(1);
    expect(dbState.hitlRespondedAt).toBeInstanceOf(Date);
  });
});

// M8 Codex review fix #3: every resume-driver terminal transition MUST
// call promoteNextPending so capacity freed by Review/Failed/Crashed
// actually promotes queued Pending runs. Mirrors runFlow's terminal
// pattern (runner.ts:586).
describe("runResumedSession — promoteNextPending on terminal transitions (Codex fix #3)", () => {
  it("crashResumedRun (terminal prompt error) calls promoteNextPending", async () => {
    streamSessionSpy.mockReturnValue(asyncIter([]));
    sendPromptSpy.mockRejectedValueOnce(
      new MaisterError("ACP_PROTOCOL", "bad message"),
    );
    crashResumedRunSpy.mockResolvedValue({ ok: true });

    await runResumedSession({
      runId: "run-1",
      supervisorSessionId: "sup-2",
      acpSessionId: "acp-1",
      stepId: "review",
      db: fakeDb,
    });

    expect(crashResumedRunSpy).toHaveBeenCalledTimes(1);
    expect(promoteNextPendingSpy).toHaveBeenCalledTimes(1);
  });

  it("crashResumedRun (no permission watchdog) calls promoteNextPending", async () => {
    streamSessionSpy.mockReturnValue(asyncIter([]));
    // No permission_request event arrives — but prompt resolves cleanly.
    sendPromptSpy.mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve({ stopReason: "end_turn" }), 0);
        }),
    );
    crashResumedRunSpy.mockResolvedValue({ ok: true });

    await runResumedSession({
      runId: "run-1",
      supervisorSessionId: "sup-2",
      acpSessionId: "acp-1",
      stepId: "review",
      db: fakeDb,
    });

    expect(crashResumedRunSpy).toHaveBeenCalledTimes(1);
    expect(promoteNextPendingSpy).toHaveBeenCalledTimes(1);
  });

  it("does NOT promote when terminal write status-guard mismatches (ok: false)", async () => {
    streamSessionSpy.mockReturnValue(asyncIter([]));
    sendPromptSpy.mockRejectedValueOnce(
      new MaisterError("ACP_PROTOCOL", "bad message"),
    );
    // Status-guard race: another transition won, our crashResumedRun no-oped.
    crashResumedRunSpy.mockResolvedValue({
      ok: false,
      reason: "status-guard-mismatch",
    });

    await runResumedSession({
      runId: "run-1",
      supervisorSessionId: "sup-2",
      acpSessionId: "acp-1",
      stepId: "review",
      db: fakeDb,
    });

    expect(crashResumedRunSpy).toHaveBeenCalledTimes(1);
    expect(promoteNextPendingSpy).not.toHaveBeenCalled();
  });

  it("retryable prompt failure (EXECUTOR_UNAVAILABLE) does NOT promote — slot stays via NeedsInputIdle", async () => {
    streamSessionSpy.mockReturnValue(asyncIter([]));
    sendPromptSpy.mockRejectedValueOnce(
      new MaisterError("EXECUTOR_UNAVAILABLE", "supervisor 503"),
    );
    rollbackResumedRunSpy.mockResolvedValue({ ok: true });

    await runResumedSession({
      runId: "run-1",
      supervisorSessionId: "sup-2",
      acpSessionId: "acp-1",
      stepId: "review",
      db: fakeDb,
    });

    expect(rollbackResumedRunSpy).toHaveBeenCalledTimes(1);
    // No promotion on rollback — NeedsInputIdle doesn't count, but the
    // operator's retry will re-claim the slot via resumeRun, so the
    // scheduler has nothing useful to do here.
    expect(promoteNextPendingSpy).not.toHaveBeenCalled();
  });
});

describe("runResumedSession — graph-only completion handoff", () => {
  it("persists the open node attempt and continues from its success edge", async () => {
    streamSessionSpy.mockReturnValue(
      asyncIter([
        {
          type: "session.permission_request",
          requestId: "req-reissued",
        },
      ]),
    );
    deliverPermissionSpy.mockResolvedValue(undefined);
    sendPromptSpy.mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve({ stopReason: "end_turn" }), 0);
        }),
    );
    markNodeSucceededSpy.mockResolvedValue(undefined);
    runFlowSpy.mockResolvedValue(undefined);

    await runResumedSession({
      runId: "run-1",
      supervisorSessionId: "sup-2",
      acpSessionId: "acp-1",
      stepId: "review",
      db: fakeDb,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(markNodeSucceededSpy).toHaveBeenCalledWith(
      "node-attempt-1",
      expect.objectContaining({ acpSessionId: "acp-1", exitCode: 0 }),
      fakeDb,
    );
    expect(runFlowSpy).toHaveBeenCalledWith("run-1", {
      db: fakeDb,
      completedResume: { targetStepId: "review" },
    });
  });
});
