import { describe, expect, it } from "vitest";

import { createResumeBackoff } from "@/lib/services/host-pressure-resume-backoff";

// ADR-183 amendment 2026-09-28 (review P4): the auto-resume used to stop a
// row for the process lifetime after three throws, and an answered row has no
// card, so nothing was left to finish it. It now backs off and never gives up.
describe("host-pressure resume backoff", () => {
  it("retries after 2^(k-1) ticks, capped at 16, and never gives up", () => {
    const backoff = createResumeBackoff();
    const waits: number[] = [];

    backoff.startTick();
    for (let failure = 1; failure <= 8; failure += 1) {
      expect(backoff.due("row")).toBe(true);
      backoff.failed("row");
      let waited = 0;

      do {
        backoff.startTick();
        waited += 1;
      } while (!backoff.due("row"));
      waits.push(waited);
    }
    expect(waits).toEqual([1, 2, 4, 8, 16, 16, 16, 16]);
  });

  it("reports the row stuck at the third consecutive throw and at every doubling after it", () => {
    const backoff = createResumeBackoff();

    backoff.startTick();
    const stuck = Array.from({ length: 7 }, () => backoff.failed("row").stuck);

    expect(stuck).toEqual([false, false, true, true, true, false, false]);
  });

  it("a success resets the count", () => {
    const backoff = createResumeBackoff();

    backoff.startTick();
    backoff.failed("row");
    backoff.failed("row");
    backoff.succeeded("row");
    expect(backoff.due("row")).toBe(true);
    expect(backoff.failed("row")).toEqual({ failures: 1, stuck: false });
  });

  it("rows back off independently", () => {
    const backoff = createResumeBackoff();

    backoff.startTick();
    backoff.failed("a");
    expect(backoff.due("a")).toBe(false);
    expect(backoff.due("b")).toBe(true);
  });
});
