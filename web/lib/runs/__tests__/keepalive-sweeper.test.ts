import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ADR-164 (K1): pass 1 checkpoints through the client bound to the run's
// execution assignment, addressed by the host's own session id from
// `run_sessions.host_session_id`. Only the delivery classification matters
// here: an unknown outcome (5xx) keeps the row NeedsInput; a definitive
// refusal — 404 or a fence from a newer driver generation — proceeds to
// markCheckpointed.
const checkpointSpy = vi.fn();
const forRunSpy = vi.fn();

vi.mock("@/lib/execution-host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/execution-host")>();

  return {
    ...actual,
    createExecutionHosts: () => ({
      forRun: (...args: unknown[]) => forRunSpy(...args),
      forAssignment: vi.fn(),
      local: vi.fn(),
    }),
  };
});

const markCheckpointedSpy = vi.fn();
const releaseSlotOnIdleSpy = vi.fn();

vi.mock("@/lib/runs/state-transitions", () => ({
  markCheckpointed: (...args: unknown[]) =>
    markCheckpointedSpy(...(args as unknown[])),
}));

vi.mock("@/lib/scheduler", () => ({
  releaseSlotOnIdle: (...args: unknown[]) =>
    releaseSlotOnIdleSpy(...(args as unknown[])),
}));

// Minimal db chain: select.from.where.orderBy.limit returns the
// seeded candidates. update.set.where.returning returns [].
type FakeRow = {
  id: string;
  hostSessionId: string | null;
};

const state: {
  pass1: FakeRow[];
  pass2: FakeRow[];
  selectCount: number;
} = { pass1: [], pass2: [], selectCount: 0 };

const fakeDb = {
  select: () => ({
    from: () => ({
      where: () => ({
        orderBy: () => ({
          limit: async () => {
            state.selectCount += 1;

            // First select call is pass1, second is pass2.
            return state.selectCount === 1 ? state.pass1 : state.pass2;
          },
        }),
      }),
    }),
  }),
  update: () => ({
    set: () => ({
      where: () => ({
        returning: async () => [],
      }),
    }),
  }),
};

vi.mock("@/lib/db/client", () => ({ getDb: () => fakeDb }));

// M42 (ADR-114): candidate queries resolve the host session id from the run's
// ACTIVE session — reflect each seeded candidate here (and keep the fake's
// select counter aligned, since this no longer hits the fake DB).
vi.mock("@/lib/runs/active-run-session", () => ({
  loadActiveRunSessionsByRunId: async (_db: unknown, runIds: string[]) => {
    const map = new Map<string, { hostSessionId: string | null }>();

    for (const row of [...state.pass1, ...state.pass2]) {
      if (runIds.includes(row.id)) {
        map.set(row.id, { hostSessionId: row.hostSessionId });
      }
    }

    return map;
  },
}));

let runSweepTick: (opts?: { db?: unknown }) => Promise<unknown>;
// Re-imported after `vi.resetModules()` so the errors the spies throw share
// the sweeper's own `@/lib/errors` module instance (`isMaisterError`).
let MaisterError: typeof import("@/lib/errors").MaisterError;

function boundClientFor(runId: string) {
  return {
    assignment: { id: `assignment-${runId}`, runId, epoch: 1 },
    checkpoint: (sessionId: string) => checkpointSpy(sessionId),
  };
}

beforeEach(async () => {
  state.pass1 = [];
  state.pass2 = [];
  state.selectCount = 0;
  forRunSpy.mockReset();
  forRunSpy.mockImplementation(async (runId: string) => boundClientFor(runId));
  checkpointSpy.mockReset();
  markCheckpointedSpy.mockReset();
  markCheckpointedSpy.mockResolvedValue({ ok: true });
  releaseSlotOnIdleSpy.mockReset();
  releaseSlotOnIdleSpy.mockResolvedValue({ promotedRunId: null });
  vi.resetModules();
  ({ MaisterError } = await import("@/lib/errors"));
  ({ runSweepTick } = await import("../keepalive-sweeper"));
});

afterEach(() => {
  vi.resetModules();
});

describe("keepalive-sweeper pass 1 — checkpoint under the run's assignment (K1)", () => {
  it("checkpoints the host session id through the client bound to the run, then marks checkpointed", async () => {
    state.pass1 = [{ id: "run-a", hostSessionId: "sess-a" }];
    checkpointSpy.mockResolvedValueOnce({
      alreadyCheckpointed: false,
      sessionId: "sess-a",
      monotonicId: 1,
    });

    const r = (await runSweepTick({ db: fakeDb })) as { idledCount: number };

    expect(r.idledCount).toBe(1);
    expect(forRunSpy).toHaveBeenCalledWith("run-a");
    expect(checkpointSpy).toHaveBeenCalledWith("sess-a");
    expect(markCheckpointedSpy).toHaveBeenCalledTimes(1);
    expect(releaseSlotOnIdleSpy).toHaveBeenCalledTimes(1);
  });

  it("5xx / unknown outcome (EXECUTOR_UNAVAILABLE) retains NeedsInput — no markCheckpointed, no release", async () => {
    state.pass1 = [
      { id: "run-a", hostSessionId: "sess-a" },
      { id: "run-b", hostSessionId: "sess-b" },
    ];
    checkpointSpy.mockRejectedValue(
      new MaisterError("EXECUTOR_UNAVAILABLE", "delivery budget exhausted"),
    );

    const r = (await runSweepTick({ db: fakeDb })) as { idledCount: number };

    expect(r.idledCount).toBe(0);
    expect(checkpointSpy).toHaveBeenCalledTimes(2);
    expect(markCheckpointedSpy).not.toHaveBeenCalled();
    expect(releaseSlotOnIdleSpy).not.toHaveBeenCalled();
  });

  it("an unreachable host at binding time is the same unknown outcome — candidate left for the next tick", async () => {
    state.pass1 = [{ id: "run-a", hostSessionId: "sess-a" }];
    forRunSpy.mockRejectedValueOnce(
      new MaisterError(
        "EXECUTOR_UNAVAILABLE",
        "local execution host unavailable",
      ),
    );

    const r = (await runSweepTick({ db: fakeDb })) as { idledCount: number };

    expect(r.idledCount).toBe(0);
    expect(checkpointSpy).not.toHaveBeenCalled();
    expect(markCheckpointedSpy).not.toHaveBeenCalled();
  });

  it("a fenced checkpoint (newer driver generation) is treated like 404: proceeds to markCheckpointed", async () => {
    state.pass1 = [{ id: "run-a", hostSessionId: "sess-a" }];
    checkpointSpy.mockRejectedValueOnce(
      new MaisterError("CONFLICT", "fenced", {
        details: { reason: "assignment_fenced", runId: "run-a" },
      }),
    );

    const r = (await runSweepTick({ db: fakeDb })) as { idledCount: number };

    expect(r.idledCount).toBe(1);
    expect(markCheckpointedSpy).toHaveBeenCalledTimes(1);
    expect(releaseSlotOnIdleSpy).toHaveBeenCalledTimes(1);
  });

  it("a definitive refusal (404 unknown session) proceeds to markCheckpointed — the session is gone", async () => {
    state.pass1 = [{ id: "run-a", hostSessionId: "sess-a" }];
    checkpointSpy.mockRejectedValueOnce(
      new MaisterError("PRECONDITION", "unknown session", {
        details: { httpStatus: 404 },
      }),
    );

    const r = (await runSweepTick({ db: fakeDb })) as { idledCount: number };

    expect(r.idledCount).toBe(1);
    expect(markCheckpointedSpy).toHaveBeenCalledTimes(1);
  });

  it("no recorded host session → marks checkpointed directly without touching the host", async () => {
    state.pass1 = [{ id: "run-a", hostSessionId: null }];

    const r = (await runSweepTick({ db: fakeDb })) as { idledCount: number };

    expect(r.idledCount).toBe(1);
    expect(forRunSpy).not.toHaveBeenCalled();
    expect(checkpointSpy).not.toHaveBeenCalled();
    expect(markCheckpointedSpy).toHaveBeenCalledTimes(1);
  });
});
