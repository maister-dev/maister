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

import { deltaTypeFor } from "@/lib/notifications/attention-consumer";

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
