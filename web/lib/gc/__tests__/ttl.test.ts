// M19 Phase 5: pure TTL derivation for the left-rail GC countdown badge.
// `deriveTtlInfo` is a clock-free, db-free projection: given a run's status +
// timestamps and the configured gcAgeDays/gcWarningDays windows, it returns the
// ttlState ("active" | "warning" | "due"), the effective removal date, and the
// archived/pruned flags. Live (non-terminal) runs NEVER count down.

import { describe, expect, it } from "vitest";

import { deriveTtlInfo } from "@/lib/gc/ttl";

const DAY_MS = 86_400_000;
const NOW = Date.UTC(2026, 5, 1, 12, 0, 0); // 2026-06-01T12:00:00Z
const AGE_DAYS = 14;
const WARNING_DAYS = 2;

// A baseline arg builder so each case overrides only the fields it cares about.
function args(over: Partial<Parameters<typeof deriveTtlInfo>[0]> = {}) {
  return {
    status: "Abandoned",
    endedAt: null as Date | null,
    scheduledRemovalAt: null as Date | null,
    archivedBranch: null as string | null,
    removedAt: null as Date | null,
    nowMs: NOW,
    ageDays: AGE_DAYS,
    warningDays: WARNING_DAYS,
    ...over,
  };
}

describe("deriveTtlInfo — live (non-terminal) runs never count down", () => {
  it("Running → active with no countdown, even if scheduledRemovalAt is set", () => {
    const info = deriveTtlInfo(
      args({
        status: "Running",
        scheduledRemovalAt: new Date(NOW - 10 * DAY_MS), // far past — ignored
        endedAt: new Date(NOW - 100 * DAY_MS),
      }),
    );

    expect(info.ttlState).toBe("active");
    expect(info.effectiveRemovalAt).toBeNull();
  });

  it.each([
    "Pending",
    "Running",
    "NeedsInput",
    "NeedsInputIdle",
    "Review",
    "Crashed",
    "Failed",
  ])("non-terminal status %s → active, effectiveRemovalAt null", (status) => {
    const info = deriveTtlInfo(
      args({ status, scheduledRemovalAt: new Date(NOW - DAY_MS) }),
    );

    expect(info.ttlState).toBe("active");
    expect(info.effectiveRemovalAt).toBeNull();
  });

  it("live run still reports archived/pruned flags from their columns", () => {
    const info = deriveTtlInfo(
      args({
        status: "Running",
        archivedBranch: "maister/archive/run-1",
        removedAt: new Date(NOW),
      }),
    );

    expect(info.ttlState).toBe("active");
    expect(info.effectiveRemovalAt).toBeNull();
    expect(info.archived).toBe(true);
    expect(info.pruned).toBe(true);
  });
});

describe("deriveTtlInfo — terminal runs with an explicit scheduledRemovalAt", () => {
  it("scheduledRemovalAt far in the future (> warning window) → active", () => {
    const effective = new Date(NOW + 10 * DAY_MS);
    const info = deriveTtlInfo(args({ scheduledRemovalAt: effective }));

    expect(info.ttlState).toBe("active");
    expect(info.effectiveRemovalAt?.getTime()).toBe(effective.getTime());
  });

  it("scheduledRemovalAt inside the warning window → warning", () => {
    const effective = new Date(NOW + 1 * DAY_MS); // 1 day out, < 2-day warning
    const info = deriveTtlInfo(args({ scheduledRemovalAt: effective }));

    expect(info.ttlState).toBe("warning");
    expect(info.effectiveRemovalAt?.getTime()).toBe(effective.getTime());
  });

  it("scheduledRemovalAt in the past (now >= effective) → due", () => {
    const effective = new Date(NOW - 1 * DAY_MS);
    const info = deriveTtlInfo(args({ scheduledRemovalAt: effective }));

    expect(info.ttlState).toBe("due");
    expect(info.effectiveRemovalAt?.getTime()).toBe(effective.getTime());
  });

  it("Done (the other terminal status) counts down the same way", () => {
    const effective = new Date(NOW + 1 * DAY_MS);
    const info = deriveTtlInfo(
      args({ status: "Done", scheduledRemovalAt: effective }),
    );

    expect(info.ttlState).toBe("warning");
  });
});

describe("deriveTtlInfo — endedAt + ageDays fallback when scheduledRemovalAt is null", () => {
  it("null scheduledRemovalAt + endedAt older than ageDays → due via fallback", () => {
    const endedAt = new Date(NOW - (AGE_DAYS + 5) * DAY_MS); // 19 days ago
    const info = deriveTtlInfo(args({ scheduledRemovalAt: null, endedAt }));

    expect(info.ttlState).toBe("due");
    expect(info.effectiveRemovalAt?.getTime()).toBe(
      endedAt.getTime() + AGE_DAYS * DAY_MS,
    );
  });

  it("null scheduledRemovalAt + recent endedAt (effective well in future) → active", () => {
    const endedAt = new Date(NOW - 1 * DAY_MS); // effective = +13d → active
    const info = deriveTtlInfo(args({ scheduledRemovalAt: null, endedAt }));

    expect(info.ttlState).toBe("active");
    expect(info.effectiveRemovalAt?.getTime()).toBe(
      endedAt.getTime() + AGE_DAYS * DAY_MS,
    );
  });

  it("null scheduledRemovalAt + endedAt placing effective inside warning window → warning", () => {
    // effective = endedAt + 14d must land 1 day ahead of now → endedAt = now - 13d.
    const endedAt = new Date(NOW - (AGE_DAYS - 1) * DAY_MS);
    const info = deriveTtlInfo(args({ scheduledRemovalAt: null, endedAt }));

    expect(info.ttlState).toBe("warning");
  });

  it("terminal run with null scheduledRemovalAt AND null endedAt → active (no countdown anchor)", () => {
    const info = deriveTtlInfo(
      args({ scheduledRemovalAt: null, endedAt: null }),
    );

    expect(info.ttlState).toBe("active");
    expect(info.effectiveRemovalAt).toBeNull();
  });

  it("scheduledRemovalAt takes precedence over the endedAt fallback when both are set", () => {
    const scheduled = new Date(NOW + 10 * DAY_MS); // active
    const endedAt = new Date(NOW - 100 * DAY_MS); // fallback would be due
    const info = deriveTtlInfo(
      args({ scheduledRemovalAt: scheduled, endedAt }),
    );

    expect(info.ttlState).toBe("active");
    expect(info.effectiveRemovalAt?.getTime()).toBe(scheduled.getTime());
  });
});

describe("deriveTtlInfo — boundary conditions", () => {
  it("now === effective → due (>= comparison, inclusive)", () => {
    const info = deriveTtlInfo(args({ scheduledRemovalAt: new Date(NOW) }));

    expect(info.ttlState).toBe("due");
  });

  it("now === effective - warningDays → warning (>= comparison, inclusive)", () => {
    const effective = new Date(NOW + WARNING_DAYS * DAY_MS);
    const info = deriveTtlInfo(args({ scheduledRemovalAt: effective }));

    expect(info.ttlState).toBe("warning");
  });

  it("one ms before the warning threshold → active", () => {
    const effective = new Date(NOW + WARNING_DAYS * DAY_MS + 1);
    const info = deriveTtlInfo(args({ scheduledRemovalAt: effective }));

    expect(info.ttlState).toBe("active");
  });

  it("one ms past effective → still due", () => {
    const effective = new Date(NOW - 1);
    const info = deriveTtlInfo(args({ scheduledRemovalAt: effective }));

    expect(info.ttlState).toBe("due");
  });
});

describe("deriveTtlInfo — archived / pruned flags", () => {
  it("archivedBranch set → archived true", () => {
    const info = deriveTtlInfo(
      args({ archivedBranch: "maister/archive/run-42" }),
    );

    expect(info.archived).toBe(true);
  });

  it("archivedBranch null → archived false", () => {
    const info = deriveTtlInfo(args({ archivedBranch: null }));

    expect(info.archived).toBe(false);
  });

  it("removedAt set → pruned true", () => {
    const info = deriveTtlInfo(args({ removedAt: new Date(NOW) }));

    expect(info.pruned).toBe(true);
  });

  it("removedAt null → pruned false", () => {
    const info = deriveTtlInfo(args({ removedAt: null }));

    expect(info.pruned).toBe(false);
  });

  it("both archived and pruned can be true together", () => {
    const info = deriveTtlInfo(
      args({
        archivedBranch: "maister/archive/run-7",
        removedAt: new Date(NOW),
      }),
    );

    expect(info.archived).toBe(true);
    expect(info.pruned).toBe(true);
  });
});
