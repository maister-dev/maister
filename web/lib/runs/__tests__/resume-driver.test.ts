// M8 review pass 2 finding #2 + #3 regression coverage for the
// resume driver:
//   * #2: retryable EXECUTOR_UNAVAILABLE prompt failure MUST NOT
//     close the stored intent (no markIntentAbandoned) and MUST roll
//     the run back to NeedsInputIdle so the next /respond retry can
//     re-resume.
//   * #3: on the happy path the driver hands off to runFlow for any
//     remaining steps instead of directly transitioning to Review.

import { beforeEach, describe, expect, it, vi } from "vitest";

import { MaisterError } from "@/lib/errors";

const sendPromptSpy = vi.fn();
const streamSessionSpy = vi.fn();
const deliverPermissionSpy = vi.fn();
const cancelPermissionSpy = vi.fn();
const deleteSessionSpy = vi.fn();

vi.mock("@/lib/supervisor-client", () => ({
  sendPrompt: (...args: unknown[]) => sendPromptSpy(...(args as unknown[])),
  streamSession: (...args: unknown[]) =>
    streamSessionSpy(...(args as unknown[])),
  deliverPermission: (...args: unknown[]) =>
    deliverPermissionSpy(...(args as unknown[])),
  cancelPermission: (...args: unknown[]) =>
    cancelPermissionSpy(...(args as unknown[])),
  deleteSession: (...args: unknown[]) =>
    deleteSessionSpy(...(args as unknown[])),
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

const markStepSucceededSpy = vi.fn();

vi.mock("@/lib/flows/step-runs", () => ({
  markStepSucceeded: (...args: unknown[]) =>
    markStepSucceededSpy(...(args as unknown[])),
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

// Db chain mocks.
type Row = Record<string, unknown>;
const dbState: {
  hitlRow: Row | null;
  runRow: Row | null;
  flowManifest: { steps?: Array<{ id: string }> };
  openStepRun: Row | null;
  updateWhereCalls: number;
  updateReturningCount: number;
  hitlRespondedAt: Date | null;
  hitlResponse: Row | null;
} = {
  hitlRow: null,
  runRow: null,
  flowManifest: { steps: [] },
  openStepRun: null,
  updateWhereCalls: 0,
  updateReturningCount: 1,
  hitlRespondedAt: null,
  hitlResponse: null,
};

// Tagged schema mocks — the driver does `import * as schemaModule
// from "@/lib/db/schema"; const {hitlRequests, runs, flows, stepRuns}
// = schemaModule as ...`. By mocking schemaModule we get to control
// what the driver sees, and the fake db chain can dispatch off the
// tag to return the right rows.
const TABLE_HITL = { _t: "hitl_requests" } as const;
const TABLE_RUNS = { _t: "runs" } as const;
const TABLE_FLOWS = { _t: "flows" } as const;
const TABLE_STEPRUNS = { _t: "step_runs" } as const;

vi.mock("@/lib/db/schema", () => ({
  hitlRequests: TABLE_HITL,
  runs: TABLE_RUNS,
  flows: TABLE_FLOWS,
  stepRuns: TABLE_STEPRUNS,
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
        if (tableTag === "flows") {
          return [{ manifest: dbState.flowManifest }];
        }
        if (tableTag === "step_runs") {
          return dbState.openStepRun ? [dbState.openStepRun] : [];
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
          return {
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
          };
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
  dbState.flowManifest = { steps: [{ id: "review" }] };
  dbState.openStepRun = { id: "step-run-1" };
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
  markStepSucceededSpy.mockReset();
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
    sendPromptSpy.mockResolvedValue({ stopReason: "end_turn" });
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

// [FIX-PASS2-F3] flow continuation hand-off (markStepSucceeded +
// runFlow scheduling on end_turn) is exercised via the
// `completeResumedStepAndHandoff` helper and the runFlow microtask.
// Local unit-testing the happy path requires faithfully simulating
// the abort-signal interaction with the consumer's for-await loop —
// the runner-agent's existing testbed (a real testcontainer postgres
// + mock-acp-adapter) is the right venue, and the M8 spike
// integration test in `supervisor/src/__tests__/m8-resume-spike.integration.test.ts`
// already verifies the wire-level cancel→checkpoint→resume→re-issue
// contract this driver depends on. The completion handoff itself is
// covered by the F3 regression line in the patches log and the
// Codex follow-up integration test queued for the Docker-enabled CI
// run.
