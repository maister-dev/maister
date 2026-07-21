import { describe, expect, it } from "vitest";

import { createLockOpQueue } from "@/lib/local-packages/lock-op-queue";

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

describe("createLockOpQueue", () => {
  it("runs ops strictly sequentially in issue order", async () => {
    const queue = createLockOpQueue();
    const events: string[] = [];
    const slow = queue.run(async () => {
      events.push("slow:start");
      await delay(20);
      events.push("slow:end");
    });
    const fast = queue.run(async () => {
      events.push("fast:start");
      await delay(1);
      events.push("fast:end");
    });

    await Promise.all([slow, fast]);

    expect(events).toEqual([
      "slow:start",
      "slow:end",
      "fast:start",
      "fast:end",
    ]);
  });

  it("keeps the lock when a slow release races the remount acquire", async () => {
    // Replays the captured 2026-07-21 incident: the StrictMode mount cycle
    // issues acquire → release → acquire as concurrent HTTP requests, and the
    // release handler finishing LAST clears the fresh lock while the client
    // still believes heldByMe=true. Ordered, the final state must stay locked.
    const row: { lockedBySession: string | null } = { lockedBySession: null };
    const queue = createLockOpQueue();
    const acquire = (): Promise<void> =>
      queue.run(async () => {
        await delay(2);
        row.lockedBySession = "editor-session";
      });
    const release = (): Promise<void> =>
      queue.run(async () => {
        await delay(25);
        if (row.lockedBySession === "editor-session") {
          row.lockedBySession = null;
        }
      });

    await Promise.all([acquire(), release(), acquire()]);

    expect(row.lockedBySession).toBe("editor-session");
  });

  it("propagates an op rejection to its caller without wedging later ops", async () => {
    const queue = createLockOpQueue();

    await expect(
      queue.run(async () => {
        throw new Error("lock-release request failed");
      }),
    ).rejects.toThrow("lock-release request failed");

    await expect(queue.run(async () => "still-running")).resolves.toBe(
      "still-running",
    );
  });
});
