// A consumer that cannot claim the stream re-requests it from its FIRST event
// and makes no ingest progress, so every retry is pure load on the shared
// database. Its retry interval must back off for as long as the other claim
// lives, not stay at the minimum.
import { describe, expect, it } from "vitest";

import {
  nextReconnectDelayMs,
  RUNTIME_EVENT_CLAIM_LEASE_MS,
  RUNTIME_EVENT_CONTESTED_CLAIM_MAX_MS,
  RUNTIME_EVENT_RECONNECT_MAX_MS,
  RUNTIME_EVENT_RECONNECT_MIN_MS,
} from "../consumer";

describe("runtime event consumer reconnect pacing", () => {
  it("resets to the minimum interval after a cycle that made progress", () => {
    for (const previous of [
      RUNTIME_EVENT_RECONNECT_MIN_MS,
      4_000,
      RUNTIME_EVENT_RECONNECT_MAX_MS,
    ])
      expect(nextReconnectDelayMs(previous, "progress")).toBe(
        RUNTIME_EVENT_RECONNECT_MIN_MS,
      );
  });

  it("backs off a claim it cannot win instead of spinning at the minimum", () => {
    let delay = RUNTIME_EVENT_RECONNECT_MIN_MS;
    const seen: number[] = [];

    for (let cycle = 0; cycle < 8; cycle += 1) {
      delay = nextReconnectDelayMs(delay, "reconnect");
      seen.push(delay);
    }
    expect(seen[0]).toBeGreaterThan(RUNTIME_EVENT_RECONNECT_MIN_MS);
    expect(seen).toStrictEqual([...seen].sort((a, b) => a - b));
    expect(seen.at(-1)).toBe(RUNTIME_EVENT_CONTESTED_CLAIM_MAX_MS);
  });

  it("bounds an unclaimable stream to a handful of retries per claim lease", () => {
    let delay = RUNTIME_EVENT_RECONNECT_MIN_MS;
    let elapsed = 0;
    let retries = 0;

    // One 30s claim lease held by another (possibly dead) owner.
    while (elapsed < 30_000) {
      delay = nextReconnectDelayMs(delay, "reconnect");
      elapsed += delay;
      retries += 1;
    }
    // ~120 retries at the old fixed minimum; bounded here without pushing
    // takeover past the lease it is waiting on.
    expect(retries).toBeLessThanOrEqual(20);
  });

  it("never delays takeover by more than a fraction of the claim lease", () => {
    let delay = RUNTIME_EVENT_RECONNECT_MIN_MS;

    for (let cycle = 0; cycle < 20; cycle += 1)
      delay = nextReconnectDelayMs(delay, "reconnect");
    expect(delay * 4).toBeLessThanOrEqual(RUNTIME_EVENT_CLAIM_LEASE_MS);
  });

  it("keeps the longer cap for transport failures, which have no known bound", () => {
    expect(nextReconnectDelayMs(RUNTIME_EVENT_RECONNECT_MIN_MS, "error")).toBe(
      RUNTIME_EVENT_RECONNECT_MIN_MS * 2,
    );
    expect(nextReconnectDelayMs(RUNTIME_EVENT_RECONNECT_MAX_MS, "error")).toBe(
      RUNTIME_EVENT_RECONNECT_MAX_MS,
    );
  });
});
