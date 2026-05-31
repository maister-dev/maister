// M8 Codex review fix #2: resume-recovery sweep — catches HITL intents
// stranded across a web-process restart between the /respond 202 and
// the queueMicrotask driver attaching.

import { describe, expect, it, vi } from "vitest";

// Stub schema tags so the driver's `schemaModule as ...` cast yields
// values our fake `select(...).from(table)` chain can dispatch on.
const TABLE_HITL = { _t: "hitl_requests" } as const;
const TABLE_RUNS = { _t: "runs" } as const;

vi.mock("@/lib/db/schema", () => ({
  hitlRequests: TABLE_HITL,
  runs: TABLE_RUNS,
  flows: { _t: "flows" },
  stepRuns: { _t: "step_runs" },
  // M11b: resume-recovery now also references these tags for the
  // takeover-return stranded-Running sweep (runTakeoverReturnRecoverySweep).
  // The Codex-fix-#2 sweep under test never touches them, but the
  // module-level destructure errors if the mock omits them.
  nodeAttempts: { _t: "node_attempts" },
  gateResults: { _t: "gate_results" },
}));

vi.mock("@/lib/db/client", () => ({
  getDb: () => {
    throw new Error("test must pass explicit db");
  },
}));

vi.mock("@/lib/runs/resume-driver", () => ({
  scheduleResumedSessionDrive: () => "stub-drive-id",
}));

vi.mock("@/lib/runs/state-transitions", () => ({
  rollbackResumedRun: () => Promise.resolve({ ok: true }),
}));

vi.mock("@/lib/supervisor-client", () => ({
  listSessions: () => Promise.resolve([]),
}));

type Row = Record<string, unknown>;

function makeFakeDb(opts: {
  needsInputRuns: Array<{
    id: string;
    acpSessionId: string | null;
    currentStepId: string | null;
  }>;
  hitlByRun: Map<string, Row[]>;
}): { db: any; rollbackCalls: Array<string> } {
  const rollbackCalls: string[] = [];

  const db = {
    select: () => ({
      from: (table: { _t?: string }) => ({
        where: (..._args: unknown[]) => {
          if (table._t === "runs") {
            return Promise.resolve(opts.needsInputRuns);
          }
          if (table._t === "hitl_requests") {
            return {
              orderBy: () => ({
                limit: () => {
                  // Find the run-scoped query by inspecting the
                  // current call context. The driver passes a specific
                  // runId via eq(); we can't see args here in this
                  // simplified fake, so return the first run's HITLs.
                  // Tests calibrate by having only one run in
                  // needsInputRuns per scenario.
                  const first = opts.needsInputRuns[0];

                  if (!first) return Promise.resolve([]);
                  const rows = opts.hitlByRun.get(first.id) ?? [];

                  return Promise.resolve(rows.slice(0, 1));
                },
              }),
            };
          }

          return Promise.resolve([]);
        },
      }),
    }),
    update: () => ({
      set: (vals: Row) => ({
        where: () => {
          if (vals.status === "NeedsInputIdle") {
            rollbackCalls.push("rollback");
          }
          const result: any = Promise.resolve([{ id: "x" }]);

          result.returning = async () => [{ id: "x" }];

          return result;
        },
      }),
    }),
  };

  return { db, rollbackCalls };
}

describe("runResumeRecoverySweep (Codex fix #2)", () => {
  it("returns zero-count result when no NeedsInput rows exist", async () => {
    const { runResumeRecoverySweep } = await import("../resume-recovery");
    const { db } = makeFakeDb({
      needsInputRuns: [],
      hitlByRun: new Map(),
    });

    const result = await runResumeRecoverySweep({ db });

    expect(result.candidatesFound).toBe(0);
    expect(result.rescheduled).toBe(0);
    expect(result.rolledBack).toBe(0);
    expect(result.skipped).toBe(0);
  });

  it("returns zero-candidate result when no HITL rows are claimed-but-undelivered", async () => {
    const { runResumeRecoverySweep } = await import("../resume-recovery");
    const { db } = makeFakeDb({
      needsInputRuns: [
        { id: "run-1", acpSessionId: "acp-1", currentStepId: "plan" },
      ],
      hitlByRun: new Map(), // No claimed rows
    });

    const result = await runResumeRecoverySweep({ db });

    expect(result.candidatesFound).toBe(0);
  });

  it("re-schedules driver when supervisor session is live", async () => {
    const { runResumeRecoverySweep } = await import("../resume-recovery");
    const { db } = makeFakeDb({
      needsInputRuns: [
        { id: "run-1", acpSessionId: "acp-1", currentStepId: "plan" },
      ],
      hitlByRun: new Map([["run-1", [{ id: "hitl-1", stepId: "plan" }]]]),
    });

    const scheduleSpy = vi.fn(() => "drive-1");
    const loadSessionsSpy = vi.fn(async () => ({
      ok: true as const,
      map: new Map([
        [
          "acp-1",
          {
            sessionId: "sup-live",
            runId: "run-1",
            projectSlug: "demo",
            stepId: "plan",
            status: "live" as const,
            pid: 1,
            startedAt: "2026-05-29T00:00:00Z",
            logPath: "x",
            monotonicId: 0,
            acpSessionId: "acp-1",
          },
        ],
      ]),
    }));

    const result = await runResumeRecoverySweep({
      db,
      loadSessions: loadSessionsSpy,
      scheduleDriver: scheduleSpy,
    });

    expect(result.candidatesFound).toBe(1);
    expect(result.rescheduled).toBe(1);
    expect(result.rolledBack).toBe(0);
    expect(scheduleSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-1",
        supervisorSessionId: "sup-live",
        acpSessionId: "acp-1",
        stepId: "plan",
      }),
    );
  });

  it("rolls back to NeedsInputIdle when supervisor session is gone", async () => {
    const { runResumeRecoverySweep } = await import("../resume-recovery");
    const { db, rollbackCalls } = makeFakeDb({
      needsInputRuns: [
        { id: "run-1", acpSessionId: "acp-gone", currentStepId: "plan" },
      ],
      hitlByRun: new Map([["run-1", [{ id: "hitl-1", stepId: "plan" }]]]),
    });

    const scheduleSpy = vi.fn(() => "drive-1");
    const loadSessionsSpy = vi.fn(async () => ({
      ok: true as const,
      map: new Map(), // supervisor knows nothing about acp-gone
    }));

    const result = await runResumeRecoverySweep({
      db,
      loadSessions: loadSessionsSpy,
      scheduleDriver: scheduleSpy,
    });

    expect(result.candidatesFound).toBe(1);
    expect(result.rescheduled).toBe(0);
    expect(result.rolledBack).toBe(1);
    expect(scheduleSpy).not.toHaveBeenCalled();
    // rollbackResumedRun is mocked, so rollbackCalls (which fires only
    // if the real db.update path runs) intentionally stays empty here.
    expect(rollbackCalls.length).toBe(0);
  });

  it("skips all candidates when supervisor listSessions fails (transient)", async () => {
    const { runResumeRecoverySweep } = await import("../resume-recovery");
    const { db } = makeFakeDb({
      needsInputRuns: [
        { id: "run-1", acpSessionId: "acp-1", currentStepId: "plan" },
      ],
      hitlByRun: new Map([["run-1", [{ id: "hitl-1", stepId: "plan" }]]]),
    });

    const scheduleSpy = vi.fn(() => "drive-1");
    const loadSessionsSpy = vi.fn(async () => ({
      ok: false as const,
      reason: "supervisor 503",
    }));

    const result = await runResumeRecoverySweep({
      db,
      loadSessions: loadSessionsSpy,
      scheduleDriver: scheduleSpy,
    });

    expect(result.candidatesFound).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.rescheduled).toBe(0);
    expect(result.rolledBack).toBe(0);
    expect(scheduleSpy).not.toHaveBeenCalled();
  });
});
