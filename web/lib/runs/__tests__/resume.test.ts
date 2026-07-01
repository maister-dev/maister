// M8 review finding #3 regression coverage. resumeRun must
// claim the NeedsInputIdle → NeedsInput transition BEFORE creating
// the supervisor session so two same-payload retries cannot both
// spawn duplicate workers. The loser receives a distinct CLAIM_RACE
// outcome (not a misleading terminal 410) so /respond can render
// 202 "resume-in-progress".

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const createSessionSpy = vi.fn();

vi.mock("@/lib/supervisor-client", () => ({
  createSession: (input: unknown) => createSessionSpy(input),
}));

// Mock state-transition helpers so we can drive markResumed outcomes
// without a real DB.
const markResumedSpy = vi.fn();
const rollbackResumedRunSpy = vi.fn();
const failResumedRunSpy = vi.fn();

vi.mock("@/lib/runs/state-transitions", () => ({
  markResumed: (...args: unknown[]) => markResumedSpy(...(args as unknown[])),
  rollbackResumedRun: (...args: unknown[]) =>
    rollbackResumedRunSpy(...(args as unknown[])),
  failResumedRun: (...args: unknown[]) =>
    failResumedRunSpy(...(args as unknown[])),
}));

// ADR-121 (T14): the cap-gate. Default = a free slot (countLiveRuns 0) so every
// pre-existing scenario proceeds to the markResumed claim exactly as before; the
// deferred (cap-full) branch is covered by the real-PG cap-gate integration test.
const countLiveRunsSpy = vi.fn(async () => 0);

vi.mock("@/lib/scheduler", () => ({
  takeSchedulerLock: async () => {},
  countLiveRuns: () => countLiveRunsSpy(),
  capForPool: () => 6,
}));

// Minimal db: select chains return seeded rows.
const dbState: {
  runRow: Record<string, unknown> | null;
  workspace: Record<string, unknown> | null;
  project: Record<string, unknown> | null;
} = { runRow: null, workspace: null, project: null };

const updateSetSpy = vi.fn();

const fakeDb = {
  select: () => ({
    from: (table: { _kind?: string } | unknown) => ({
      where: async () => {
        // Order of selects in resumeRun:
        //   1. runs (status, acpSessionId, runnerSnapshot, currentStepId, projectId)
        //   2. workspaces
        //   3. projects
        // We use a call counter to pick the right seeded row.
        callOrder.push(table);
        const idx = callOrder.length;

        if (idx === 1) return dbState.runRow ? [dbState.runRow] : [];
        if (idx === 2) return dbState.workspace ? [dbState.workspace] : [];
        if (idx === 3) return dbState.project ? [dbState.project] : [];

        return [];
      },
    }),
  }),
  // ADR-121 (T14): the cap-gate runs the markResumed claim inside one locked tx.
  // The fake threads the same handle through so the markResumed mock still fires.
  transaction: async (fn: (tx: unknown) => unknown) => fn(fakeDb),
  update: () => ({
    set: (payload: unknown) => {
      updateSetSpy(payload);

      return { where: async () => undefined };
    },
  }),
};

const callOrder: unknown[] = [];

vi.mock("@/lib/db/client", () => ({ getDb: () => fakeDb }));

// M42 (ADR-114): resumeRun now reads the resume handle + runner snapshot from the
// run's ACTIVE session; the fake reflects the seeded run row's values.
vi.mock("@/lib/runs/active-run-session", () => ({
  loadActiveRunSession: async () =>
    dbState.runRow
      ? {
          sessionName: "default",
          acpSessionId: dbState.runRow.acpSessionId ?? null,
          runnerSnapshot: dbState.runRow.runnerSnapshot ?? null,
          capabilityAgent: null,
          runnerId: null,
          runnerResolutionTier: null,
        }
      : null,
}));

let resumeRun: (
  runId: string,
  opts?: { db?: unknown },
) => Promise<{
  ok: boolean;
  code?: string;
  retryable?: boolean;
  message?: string;
  newSupervisorSessionId?: string;
  acpSessionId?: string;
}>;

beforeEach(async () => {
  dbState.runRow = {
    id: "run-1",
    projectId: "p1",
    status: "NeedsInputIdle",
    acpSessionId: "acp-1",
    currentStepId: "step-1",
    runnerSnapshot: {
      id: "claude-runner",
      adapter: "claude",
      capabilityAgent: "claude",
      model: "claude-sonnet-4-6",
      provider: { kind: "anthropic" },
      providerKind: "anthropic",
      permissionPolicy: "default",
      sidecarId: null,
    },
  };
  dbState.workspace = {
    projectSlug: "p1",
    worktreePath: "/tmp/wt",
  };
  dbState.project = { slug: "p1" };
  callOrder.length = 0;
  createSessionSpy.mockReset();
  markResumedSpy.mockReset();
  rollbackResumedRunSpy.mockReset();
  failResumedRunSpy.mockReset();
  updateSetSpy.mockReset();
  countLiveRunsSpy.mockReset();
  countLiveRunsSpy.mockResolvedValue(0);
  vi.resetModules();
  ({ resumeRun } = await import("../resume"));
});

afterEach(() => {
  vi.resetModules();
});

describe("resumeRun — claim-before-spawn ordering", () => {
  it("claims FIRST then spawns: markResumed runs before createSession", async () => {
    const order: string[] = [];

    markResumedSpy.mockImplementation(async () => {
      order.push("markResumed");

      return { ok: true };
    });
    createSessionSpy.mockImplementation(async () => {
      order.push("createSession");

      return {
        sessionId: "sup-new",
        pid: 99,
        acpSessionId: "acp-1",
      };
    });

    const r = await resumeRun("run-1");

    expect(r.ok).toBe(true);
    expect(order).toEqual(["markResumed", "createSession"]);
  });

  it("claim race: markResumed fails → returns CLAIM_RACE without calling createSession (no duplicate worker)", async () => {
    markResumedSpy.mockResolvedValue({
      ok: false,
      reason: "status-guard-mismatch",
    });

    const r = await resumeRun("run-1");

    expect(r.ok).toBe(false);
    expect(r.code).toBe("CLAIM_RACE");
    expect(r.retryable).toBe(false);
    expect(createSessionSpy).not.toHaveBeenCalled();
    expect(failResumedRunSpy).not.toHaveBeenCalled();
    expect(rollbackResumedRunSpy).not.toHaveBeenCalled();
  });

  it("retryable spawn failure rolls back the claim → row returns to NeedsInputIdle", async () => {
    markResumedSpy.mockResolvedValue({ ok: true });
    const MaisterError = (await import("@/lib/errors")).MaisterError;

    createSessionSpy.mockRejectedValueOnce(
      new MaisterError("EXECUTOR_UNAVAILABLE", "supervisor 503"),
    );
    rollbackResumedRunSpy.mockResolvedValue({ ok: true });

    const r = await resumeRun("run-1");

    expect(r.ok).toBe(false);
    expect(r.code).toBe("EXECUTOR_UNAVAILABLE");
    expect(r.retryable).toBe(true);
    expect(rollbackResumedRunSpy).toHaveBeenCalledTimes(1);
    expect(failResumedRunSpy).not.toHaveBeenCalled();
  });

  it("terminal spawn failure (400/CHECKPOINT) marks Failed via failResumedRun — no rollback", async () => {
    markResumedSpy.mockResolvedValue({ ok: true });
    const MaisterError = (await import("@/lib/errors")).MaisterError;

    createSessionSpy.mockRejectedValueOnce(
      new MaisterError("CHECKPOINT", "supervisor 400 spawn refused"),
    );
    failResumedRunSpy.mockResolvedValue({ ok: true });

    const r = await resumeRun("run-1");

    expect(r.ok).toBe(false);
    expect(r.code).toBe("CHECKPOINT");
    expect(r.retryable).toBe(false);
    expect(failResumedRunSpy).toHaveBeenCalledTimes(1);
    expect(rollbackResumedRunSpy).not.toHaveBeenCalled();
  });

  it("empty acpSessionId from supervisor → CHECKPOINT terminal", async () => {
    markResumedSpy.mockResolvedValue({ ok: true });
    createSessionSpy.mockResolvedValueOnce({
      sessionId: "sup-new",
      pid: 1,
      acpSessionId: "",
    });
    failResumedRunSpy.mockResolvedValue({ ok: true });

    const r = await resumeRun("run-1");

    expect(r.ok).toBe(false);
    expect(r.code).toBe("CHECKPOINT");
    expect(failResumedRunSpy).toHaveBeenCalledTimes(1);
  });

  it("missing acpSessionId on the run row fails terminally without claim or spawn", async () => {
    if (dbState.runRow) {
      dbState.runRow.acpSessionId = null;
    }
    failResumedRunSpy.mockResolvedValue({ ok: true });

    const r = await resumeRun("run-1");

    expect(r.ok).toBe(false);
    expect(r.code).toBe("CHECKPOINT");
    expect(markResumedSpy).not.toHaveBeenCalled();
    expect(createSessionSpy).not.toHaveBeenCalled();
    expect(failResumedRunSpy).toHaveBeenCalledTimes(1);
  });

  it("ADR-121 T14: flow pool at cap → QUEUED (no claim, no spawn); resume_requested_at stamped", async () => {
    // The cap-gate sees the pool at cap → defers the resume instead of bypassing
    // the cap (the D2 fix). markResumed + createSession must NOT run; the row stays
    // NeedsInputIdle with resume_requested_at stamped for the gate's C3 source.
    countLiveRunsSpy.mockResolvedValue(6);

    const r = await resumeRun("run-1");

    expect(r.ok).toBe(false);
    expect(r.code).toBe("QUEUED");
    expect(markResumedSpy).not.toHaveBeenCalled();
    expect(createSessionSpy).not.toHaveBeenCalled();
    // resume_requested_at was stamped (the only update on this path).
    expect(updateSetSpy).toHaveBeenCalledTimes(1);
    expect(updateSetSpy.mock.calls[0][0]).toHaveProperty("resumeRequestedAt");
  });

  it("run already moved out of NeedsInputIdle → PRECONDITION; no claim, no spawn", async () => {
    if (dbState.runRow) {
      dbState.runRow.status = "Running";
    }
    const r = await resumeRun("run-1");

    expect(r.ok).toBe(false);
    expect(r.code).toBe("PRECONDITION");
    expect(markResumedSpy).not.toHaveBeenCalled();
    expect(createSessionSpy).not.toHaveBeenCalled();
  });
});
