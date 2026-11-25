import type { Db } from "@/lib/execution-host/db";

import { getEventListeners } from "node:events";

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  librarianConversations,
  librarianMessages,
  librarianTurns,
} from "@/lib/db/schema";
import { librarianStreamFrames } from "@/lib/librarian/stream";

vi.mock("@/lib/librarian/confirmation-availability", () => ({
  readEligibleConfirmationIds: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/lib/librarian/settings", () => ({
  readLibrarianSettings: vi.fn().mockResolvedValue({
    enabled: true,
    runnerId: null,
    runner: null,
    availability: "ready",
  }),
}));

vi.mock("@/lib/librarian/view", () => ({
  librarianActivityIndicator: vi.fn().mockResolvedValue("running"),
  loadLatestTurn: vi.fn().mockResolvedValue(null),
}));

function createFakeDb(options: {
  onIteration: (iteration: number) => void;
  isActive: (iteration: number) => boolean;
}): { db: Db; getIterations: () => number } {
  let iterations = 0;

  const conversationRow = {
    id: "conv-1",
    userId: "user-1",
    lastSeq: 1n,
    readThroughSeq: 1n,
    resetState: "none",
    currentSegmentId: "seg-1",
    contextEpoch: 1,
    generation: 1,
  };

  const select = () => ({
    from: (table: unknown) => ({
      where: () => {
        if (table === librarianConversations) {
          return Promise.resolve([conversationRow]);
        }

        if (table === librarianMessages) {
          return {
            orderBy: () => ({
              limit: () => Promise.resolve([]),
            }),
          };
        }

        if (table === librarianTurns) {
          return {
            limit: () =>
              Promise.resolve(
                options.isActive(iterations) ? [{ id: "turn-1" }] : [],
              ),
          };
        }

        return Promise.resolve([]);
      },
    }),
  });

  const execute = () =>
    Promise.resolve({ rows: [{ access: "a1", work: "w1" }] });

  const tx = { select, execute };

  const db = {
    select,
    execute,
    transaction: async <T>(fn: (trx: typeof tx) => Promise<T>): Promise<T> => {
      iterations += 1;
      options.onIteration(iterations);

      return fn(tx);
    },
  } as unknown as Db;

  return { db, getIterations: () => iterations };
}

describe("PERF-01: librarianStreamFrames AbortSignal listener lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not leak abort listeners across 50 poll iterations and cleans up on abort", async () => {
    const controller = new AbortController();
    const listenerCountsPerIteration: number[] = [];
    let midSleepListeners: number | null = null;
    let abortTimer: ReturnType<typeof setTimeout> | null = null;

    const { db, getIterations } = createFakeDb({
      onIteration: (iteration) => {
        listenerCountsPerIteration.push(
          getEventListeners(controller.signal, "abort").length,
        );

        if (iteration === 51) {
          // Iteration 51 enters the long idle sleep; abort mid-sleep to confirm
          // immediate wake-up and zero residual listeners.
          abortTimer = setTimeout(() => {
            midSleepListeners = getEventListeners(
              controller.signal,
              "abort",
            ).length;
            controller.abort();
          }, 15);
        }
      },
      isActive: (iteration) => iteration <= 50,
    });

    const startedAt = Date.now();
    const frames: string[] = [];

    try {
      for await (const frame of librarianStreamFrames({
        db,
        ownerId: "user-1",
        cursor: 1n,
        signal: controller.signal,
        timings: {
          activePollMs: 1,
          idlePollMs: 10_000,
          disabledPollMs: 10_000,
          heartbeatMs: 60_000,
          quietCloseMs: 60_000,
        },
      })) {
        frames.push(frame);
      }
    } finally {
      if (abortTimer !== null) clearTimeout(abortTimer);
    }

    const elapsedMs = Date.now() - startedAt;

    expect(frames.length).toBeGreaterThan(0);
    expect(getIterations()).toBe(51);
    expect(elapsedMs).toBeLessThan(5_000);
    expect(Math.max(...listenerCountsPerIteration)).toBeLessThanOrEqual(1);
    expect(midSleepListeners).not.toBeNull();
    expect(midSleepListeners!).toBeLessThanOrEqual(1);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  it("completes immediately with 0 abort listeners when given an already-aborted signal", async () => {
    const controller = new AbortController();

    controller.abort();

    const { db, getIterations } = createFakeDb({
      onIteration: () => {},
      isActive: () => true,
    });

    const frames: string[] = [];

    for await (const frame of librarianStreamFrames({
      db,
      ownerId: "user-1",
      cursor: 1n,
      signal: controller.signal,
      timings: {
        activePollMs: 1,
        idlePollMs: 10_000,
        disabledPollMs: 10_000,
        heartbeatMs: 60_000,
        quietCloseMs: 60_000,
      },
    })) {
      frames.push(frame);
    }

    expect(frames).toHaveLength(0);
    expect(getIterations()).toBe(0);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });
});
