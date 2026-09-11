import { afterEach, describe, expect, it } from "vitest";

import { issueOwnedPrompt } from "@/lib/execution-host/ledger";
import { UPGRADE_MAINTENANCE_ENV } from "@/lib/maintenance/upgrade-fence";
import { runSystemSweep } from "@/lib/scheduler/system-sweeps";
import { runSchedulerTick } from "@/lib/scheduler/tick-service";

const originalFence = process.env[UPGRADE_MAINTENANCE_ENV];

// Any database access from a fenced boundary is a wiring defect: the fence must
// refuse before the boundary opens a transaction, so these stubs throw.
const refusingDb = {
  transaction: () => {
    throw new Error("a fenced boundary must not open a transaction");
  },
  execute: () => {
    throw new Error("a fenced boundary must not query the database");
  },
} as never;

afterEach(() => {
  if (originalFence === undefined) delete process.env[UPGRADE_MAINTENANCE_ENV];
  else process.env[UPGRADE_MAINTENANCE_ENV] = originalFence;
});

describe("upgrade maintenance fence wiring", () => {
  it("refuses a new prompt turn before it reaches the command ledger", async () => {
    process.env[UPGRADE_MAINTENANCE_ENV] = "1";

    await expect(
      issueOwnedPrompt(refusingDb, {
        assignment: {
          id: "assignment-1",
          runId: "run-1",
          epoch: 1,
          executionHostId: "host-1",
        } as never,
        host: { id: "host-1" } as never,
        targetSessionId: "session-1",
        payload: { prompt: "hello" } as never,
        maxAttempts: 1,
        admitOwner: () => {
          throw new Error("a fenced prompt must not admit an owner");
        },
      }),
    ).rejects.toMatchObject({
      code: "PRECONDITION",
      details: {
        reason: "upgrade_maintenance_fence",
        operation: "prompt_turn",
      },
    });
  });

  it("claims no scheduler job while the fence is engaged", async () => {
    process.env[UPGRADE_MAINTENANCE_ENV] = "1";

    await expect(runSchedulerTick()).resolves.toEqual({
      attemptedCount: 0,
      claimedCount: 0,
      succeededCount: 0,
      failedCount: 0,
      skippedCount: 0,
      attempts: [],
    });
  });

  it("refuses destructive GC while the fence is engaged", async () => {
    process.env[UPGRADE_MAINTENANCE_ENV] = "1";

    await expect(runSystemSweep()).rejects.toMatchObject({
      code: "PRECONDITION",
      details: {
        reason: "upgrade_maintenance_fence",
        operation: "destructive_gc",
      },
    });
  });
});
