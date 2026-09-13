/**
 * `UT-NTF-08` / `EDGE-NTF-01` — the delta rule and convergence.
 *
 * The count is injected, so this is about the DECISION the consumer makes given
 * a count, not about the queue query. Two claims matter:
 *
 *   - a notification fires on a DELTA, never on an event (`NTF-08`);
 *   - an at-least-once redelivery of the same window emits nothing the second
 *     time (`EDGE-NTF-01`).
 */

import { describe, expect, it } from "vitest";

import {
  buildAttentionConsumer,
  deltaTypeFor,
} from "@/lib/notifications/attention-consumer";

describe("UT-NTF-08 deltaTypeFor", () => {
  it("emits nothing when the count did not move", () => {
    // The load-bearing case: three events in one window that leave the reader's
    // number where it was produce NO notification at all.
    expect(deltaTypeFor(0, 0)).toBeNull();
    expect(deltaTypeFor(4, 4)).toBeNull();
  });

  it("calls the 0 to n edge 'opened'", () => {
    expect(deltaTypeFor(0, 1)).toBe("attention.decision_opened");
    expect(deltaTypeFor(0, 7)).toBe("attention.decision_opened");
  });

  it("calls the n to 0 edge 'closed'", () => {
    expect(deltaTypeFor(3, 0)).toBe("attention.decision_closed");
  });

  it("calls a move between two non-zero values 'changed'", () => {
    expect(deltaTypeFor(1, 2)).toBe("attention.decisions_changed");
    expect(deltaTypeFor(5, 2)).toBe("attention.decisions_changed");
  });

  it("returns one of exactly the four declared types, or null", () => {
    const seen = new Set<string | null>();

    for (let previous = 0; previous < 4; previous += 1) {
      for (let current = 0; current < 4; current += 1) {
        seen.add(deltaTypeFor(previous, current));
      }
    }

    expect([...seen].sort()).toEqual([
      "attention.decision_closed",
      "attention.decision_opened",
      "attention.decisions_changed",
      null,
    ]);
  });
});

// ---------------------------------------------------------------------------
// UT-NTF-12 — a failing reader costs LATENCY, not delivery.
//
// `dispatchDomainEvents` advances the cursor on a clean return, so swallowing a
// per-reader failure used to lose that notification outright. Rethrowing is the
// opposite failure: one broken reader stalls the cursor for everyone, and a
// deployment with a single reader cannot even tell "all readers failed" from
// "the only reader is poison" — they are the same observation.
//
// So the consumer stays poison-safe and the `system_sweep` delta backstop is
// the retry: it recomputes every reader holding an enabled intent, which is
// exactly the population that could have received anything. The pairing is what
// these tests pin — swallow HERE (`IT-NTF-14` covers the retry).
// ---------------------------------------------------------------------------
describe("UT-NTF-12 consumer failure handling", () => {
  const event = {
    id: 1n,
    kind: "run.review",
    projectId: "p1",
  } as unknown as Parameters<
    ReturnType<typeof buildAttentionConsumer>["handle"]
  >[0][number];

  function consumerOver(
    readers: Array<{ id: string; role: "admin" | "member" | "viewer" }>,
    decisionsFor: (userId: string) => Promise<number>,
  ) {
    return buildAttentionConsumer({
      db: {
        execute: async (q: unknown) =>
          String(q).includes("webhook_events")
            ? { rows: [] }
            : { rows: readers },
      },
      decisionsFor: async (userId) => decisionsFor(userId),
    });
  }

  it("does not let one reader's failure stall the cursor for the rest", async () => {
    const seen: string[] = [];
    const consumer = consumerOver(
      [
        { id: "a", role: "member" },
        { id: "b", role: "member" },
      ],
      async (userId) => {
        if (userId === "a") throw new Error("queue unavailable");
        seen.push(userId);

        return 0;
      },
    );

    await expect(consumer.handle([event])).resolves.toBeUndefined();
    // The discriminant: the reader AFTER the failing one was still served, so
    // the loop absorbed the failure rather than abandoning the batch.
    expect(seen).toEqual(["b"]);
  });

  it("stays poison-safe when EVERY reader fails, including a lone one", async () => {
    // A single-reader deployment is the case a count-based "all failed" rule
    // gets wrong: it cannot distinguish an outage from one poison reader.
    for (const readers of [
      [{ id: "only", role: "member" as const }],
      [
        { id: "a", role: "member" as const },
        { id: "b", role: "member" as const },
      ],
    ]) {
      const consumer = consumerOver(readers, async () => {
        throw new Error("database is down");
      });

      await expect(consumer.handle([event])).resolves.toBeUndefined();
    }
  });

  it("does not throw when there were no readers at all", async () => {
    const consumer = consumerOver([], async () => 0);

    await expect(consumer.handle([event])).resolves.toBeUndefined();
  });
});
