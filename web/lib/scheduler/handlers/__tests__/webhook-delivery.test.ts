import { describe, expect, it } from "vitest";

import { runWebhookDeliveryJob } from "@/lib/scheduler/handlers/webhook-delivery";

function stubDbReturning(rows: Array<{ webhooksEnabled: boolean }>) {
  return {
    select: () => ({
      from: () => ({
        where: async () => rows,
      }),
    }),
  };
}

// The disabled short-circuit is the only pure-unit behavior — it returns before
// any fanout/drain/prune DB work, so a minimal `select` stub suffices. The
// enabled path (real fanout + drain + prune SQL, zero-count summary, kill-switch
// vs. enabled accounting incl. `pruned`) is covered against a real Postgres in
// lib/scheduler/__tests__/webhook-delivery.integration.test.ts and
// lib/webhooks/__tests__/{delivery,retention}.integration.test.ts.
describe("runWebhookDeliveryJob", () => {
  it("no-ops with skipped:disabled when webhooksEnabled is false", async () => {
    const summary = await runWebhookDeliveryJob({
      db: stubDbReturning([{ webhooksEnabled: false }]),
    });

    expect(summary).toEqual({
      skipped: "disabled",
      fanout: 0,
      delivered: 0,
      failed: 0,
      dead: 0,
      pruned: 0,
    });
  });
});
