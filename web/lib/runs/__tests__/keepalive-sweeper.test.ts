// M8 review finding #1 regression coverage. The sweeper's pass 1
// must NOT mark any candidate as checkpointed when listSessions()
// fails — that would produce a split-brain state where the DB says
// the slot is free while the supervisor might still be holding a
// live worker on the original permission deferred.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const listSessionsSpy = vi.fn();
const checkpointSessionSpy = vi.fn();

vi.mock("@/lib/supervisor-client", () => ({
  listSessions: () => listSessionsSpy(),
  checkpointSession: (id: string) => checkpointSessionSpy(id),
}));

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
  acpSessionId: string | null;
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

let runSweepTick: (opts?: { db?: unknown }) => Promise<unknown>;

beforeEach(async () => {
  state.pass1 = [];
  state.pass2 = [];
  state.selectCount = 0;
  listSessionsSpy.mockReset();
  checkpointSessionSpy.mockReset();
  markCheckpointedSpy.mockReset();
  releaseSlotOnIdleSpy.mockReset();
  vi.resetModules();
  ({ runSweepTick } = await import("../keepalive-sweeper"));
});

afterEach(() => {
  vi.resetModules();
});

describe("keepalive-sweeper — supervisor-unavailable handling", () => {
  it("aborts pass 1 entirely when listSessions() throws — no markCheckpointed, no release", async () => {
    state.pass1 = [
      { id: "run-a", acpSessionId: "acp-a" },
      { id: "run-b", acpSessionId: "acp-b" },
    ];
    listSessionsSpy.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const r = (await runSweepTick({ db: fakeDb })) as {
      idledCount: number;
      abandonedCount: number;
      scannedRunsCount: number;
    };

    expect(r.idledCount).toBe(0);
    expect(markCheckpointedSpy).not.toHaveBeenCalled();
    expect(releaseSlotOnIdleSpy).not.toHaveBeenCalled();
    expect(checkpointSessionSpy).not.toHaveBeenCalled();
  });

  it("proceeds normally when listSessions() succeeds with no matching session — marks checkpointed directly", async () => {
    state.pass1 = [{ id: "run-a", acpSessionId: "acp-a" }];
    listSessionsSpy.mockResolvedValueOnce([]);
    markCheckpointedSpy.mockResolvedValue({ ok: true });
    releaseSlotOnIdleSpy.mockResolvedValue({ promotedRunId: null });

    const r = (await runSweepTick({ db: fakeDb })) as {
      idledCount: number;
    };

    expect(r.idledCount).toBe(1);
    expect(markCheckpointedSpy).toHaveBeenCalledTimes(1);
    expect(releaseSlotOnIdleSpy).toHaveBeenCalledTimes(1);
    expect(checkpointSessionSpy).not.toHaveBeenCalled();
  });

  it("when listSessions() succeeds AND a live session matches — checkpoint+mark", async () => {
    state.pass1 = [{ id: "run-a", acpSessionId: "acp-a" }];
    listSessionsSpy.mockResolvedValueOnce([
      {
        sessionId: "sup-1",
        runId: "run-a",
        projectSlug: "p",
        stepId: "s",
        status: "live",
        pid: 1,
        startedAt: "",
        logPath: "",
        monotonicId: 0,
        acpSessionId: "acp-a",
      },
    ]);
    checkpointSessionSpy.mockResolvedValueOnce({
      alreadyCheckpointed: false,
      sessionId: "sup-1",
      monotonicId: 1,
    });
    markCheckpointedSpy.mockResolvedValue({ ok: true });
    releaseSlotOnIdleSpy.mockResolvedValue({ promotedRunId: null });

    const r = (await runSweepTick({ db: fakeDb })) as { idledCount: number };

    expect(r.idledCount).toBe(1);
    expect(checkpointSessionSpy).toHaveBeenCalledWith("sup-1");
    expect(markCheckpointedSpy).toHaveBeenCalledTimes(1);
  });
});
