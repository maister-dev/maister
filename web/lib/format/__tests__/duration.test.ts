import { describe, expect, it } from "vitest";

import { formatDurationMs } from "../duration";

describe("formatDurationMs", () => {
  it.each([
    [null, "—"],
    [59_000, "59 s"],
    [60_000, "1 min"],
    [61_000, "1 min 01 s"],
    [3_600_000, "1 h 00 min"],
    [3_900_000, "1 h 05 min"],
    [90_000_000, "25 h 00 min"],
  ])("%s ms → %s", (ms, expected) => {
    expect(formatDurationMs(ms, { h: "h", min: "min", s: "s" })).toBe(expected);
  });
});
