// M19 Phase 1 (T1.A): crashRunningRun — the Running → Crashed CAS used by
// reconciliation/GC when a Running row has lost its worktree, its agent
// session, or sits on a not-retry-safe CLI step. Mirrors crashResumedRun's
// shape but guards on status='Running' and additionally clears
// current_step_id + resume_started_at.
//
// Unit-level proof: the .set payload (status/currentStepId/resumeStartedAt)
// and the WHERE guard (id + status='Running'), driven off the .returning()
// row count for the CAS-win vs CAS-miss branches. The real SQL-level CAS is
// re-proven against Postgres in state-transitions-crash.integration.test.ts.

import { beforeEach, describe, expect, it, vi } from "vitest";

// Record eq()/and() predicate calls without losing the real drizzle module.
const predicateCalls = vi.hoisted(() => ({
  eq: [] as Array<{ col: unknown; val: unknown }>,
}));

vi.mock("drizzle-orm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("drizzle-orm")>();

  return {
    ...actual,
    eq: (col: unknown, val: unknown) => {
      predicateCalls.eq.push({ col, val });

      return { __eq: true, col, val };
    },
    and: (...parts: unknown[]) => ({ __and: true, parts }),
  };
});

import * as schemaModule from "@/lib/db/schema";

const { runs } = schemaModule as unknown as Record<string, any>;

type Captured = {
  setArg: Record<string, unknown> | null;
  whereArg: unknown;
};

function mockDb(returningRows: Array<{ id: string }>): {
  db: unknown;
  captured: Captured;
} {
  const captured: Captured = { setArg: null, whereArg: undefined };

  const db = {
    update() {
      return {
        set(arg: Record<string, unknown>) {
          captured.setArg = arg;

          return {
            where(arg2: unknown) {
              captured.whereArg = arg2;

              return {
                async returning() {
                  return returningRows;
                },
              };
            },
          };
        },
      };
    },
  };

  return { db, captured };
}

let crashRunningRun: typeof import("@/lib/runs/state-transitions").crashRunningRun;

beforeEach(async () => {
  predicateCalls.eq.length = 0;
  ({ crashRunningRun } = await import("@/lib/runs/state-transitions"));
});

describe("crashRunningRun — Running → Crashed CAS", () => {
  it("CAS win: returns {ok:true} when the row was Running", async () => {
    const { db, captured } = mockDb([{ id: "run-1" }]);

    const r = await crashRunningRun("run-1", "agent-session-gone", {
      db: db as never,
    });

    expect(r).toEqual({ ok: true });

    // .set payload: terminal Crashed, clears step pointer + resume stamp.
    expect(captured.setArg?.status).toBe("Crashed");
    expect(captured.setArg?.currentStepId).toBeNull();
    expect(captured.setArg?.resumeStartedAt).toBeNull();
    expect(captured.setArg?.endedAt).toBeInstanceOf(Date);
  });

  it("CAS miss: returns {ok:false, reason:'status-guard-mismatch'} when not Running", async () => {
    const { db } = mockDb([]);

    const r = await crashRunningRun("run-2", "worktree-gone", {
      db: db as never,
    });

    expect(r).toEqual({ ok: false, reason: "status-guard-mismatch" });
  });

  it("WHERE guards on id and status='Running'", async () => {
    const { db } = mockDb([{ id: "run-3" }]);

    await crashRunningRun("run-3", "cli-not-retry-safe", { db: db as never });

    const onId = predicateCalls.eq.find(
      (c) => (c.col as { name?: string })?.name === "id",
    );
    const onStatus = predicateCalls.eq.find(
      (c) => (c.col as { name?: string })?.name === "status",
    );

    expect(onId?.val).toBe("run-3");
    expect(onStatus?.val).toBe("Running");
  });

  it("does not call set with a Running status guard value as the update target", async () => {
    // Sanity: the status SET target is Crashed, never Running — the only
    // 'Running' reference is the WHERE guard.
    const { db, captured } = mockDb([{ id: "run-4" }]);

    await crashRunningRun("run-4", "agent-session-gone", { db: db as never });

    expect(captured.setArg?.status).not.toBe("Running");
  });

  it("accepts every CrashReason variant", async () => {
    const reasons = [
      "worktree-gone",
      "agent-session-gone",
      "cli-not-retry-safe",
    ] as const;

    for (const reason of reasons) {
      const { db } = mockDb([{ id: "run-x" }]);
      const r = await crashRunningRun("run-x", reason, { db: db as never });

      expect(r).toEqual({ ok: true });
    }
  });
});
