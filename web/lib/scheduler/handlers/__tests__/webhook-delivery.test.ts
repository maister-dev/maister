import { describe, expect, it } from "vitest";

import { runWebhookDeliveryJob } from "@/lib/scheduler/handlers/webhook-delivery";

function stubDbReturning(rows: Array<{ webhooksEnabled: boolean }>) {
  const stub = {
    select: () => ({
      from: () => ({
        where: async () => rows,
      }),
    }),
    // The disabled path still runs the skip pass (stamp un-fanned events
    // consumed-and-dropped) in one tx — stub it to zero claimed rows.
    transaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn(stub),
    execute: async () => ({ rowCount: 0, rows: [] }),
  };

  return stub;
}

// The disabled branch's accounting is the only stub-unit behavior — it skips
// fanout/drain/prune and only runs the skip pass. The enabled path (real
// fanout + drain + prune SQL, zero-count summary, kill-switch vs. enabled
// accounting incl. `pruned`) and the skip pass against real rows are covered
// against a real Postgres in
// lib/scheduler/__tests__/webhook-delivery.integration.test.ts and
// lib/webhooks/__tests__/{delivery,retention}.integration.test.ts.
describe("runWebhookDeliveryJob", () => {
  it("skip-passes with skipped:disabled when webhooksEnabled is false", async () => {
    const summary = await runWebhookDeliveryJob({
      db: stubDbReturning([{ webhooksEnabled: false }]),
    });

    expect(summary).toEqual({
      skipped: "disabled",
      skippedEvents: 0,
      fanout: 0,
      delivered: 0,
      failed: 0,
      dead: 0,
      pruned: 0,
    });
  });
});
