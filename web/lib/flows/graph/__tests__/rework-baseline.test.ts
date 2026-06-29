import { describe, expect, it } from "vitest";

import { effectiveAttempts } from "@/lib/flows/graph/rework-baseline";

// ADR-118 AC-10: effective = attemptNumber - (baseline ?? 0) at both exhaustion
// sites; total allowed per epoch = maxLoops + 1 (no off-by-one).
describe("effectiveAttempts (ADR-118)", () => {
  it("treats a NULL/undefined baseline as 0 (back-compat)", () => {
    expect(effectiveAttempts(2, null)).toBe(2);
    expect(effectiveAttempts(2, undefined)).toBe(2);
    expect(effectiveAttempts(1, 0)).toBe(1);
  });

  it("subtracts the baseline (a reset re-baselines the epoch)", () => {
    // baseline 3 means 3 attempts were spent before this epoch began.
    expect(effectiveAttempts(4, 3)).toBe(1);
    expect(effectiveAttempts(8, 4)).toBe(4);
  });

  it("the maxLoops+1 boundary: exhaustion fires at effective > maxLoops", () => {
    const maxLoops = 3;

    // No reset: visits 1..4 allowed (effective 1..4); exhaustion at effective 5.
    expect(effectiveAttempts(4, 0) > maxLoops).toBe(true); // visit 4 -> effective 4 > 3
    expect(effectiveAttempts(3, 0) > maxLoops).toBe(false); // visit 3 -> effective 3
    expect(effectiveAttempts(4, 0)).toBe(maxLoops + 1);

    // After a reset at attempt 4 (baseline 4): a full fresh budget — visit 8
    // (effective 4) is the new exhaustion boundary.
    expect(effectiveAttempts(7, 4) > maxLoops).toBe(false); // effective 3
    expect(effectiveAttempts(8, 4) > maxLoops).toBe(true); // effective 4 > 3
    expect(effectiveAttempts(8, 4)).toBe(maxLoops + 1);
  });
});
