import { describe, expect, it } from "vitest";

import {
  pgVectorRecallRanker,
  RANKER_VERSION,
  resolveRecallRanker,
  type RankedBrainItem,
  type RecallRanker,
} from "@/lib/brain/recall-ranker";

// T2.3 — the RecallRanker seam (D9). The behavioral hybrid-rank test lives in
// T4.1 (integration); here we lock the interface contract + injection.
describe("RecallRanker seam (T2.3)", () => {
  it("resolveRecallRanker returns the default pgvector ranker when no override is given", () => {
    expect(resolveRecallRanker()).toBe(pgVectorRecallRanker);
    expect(resolveRecallRanker().version).toBe(RANKER_VERSION);
  });

  it("resolveRecallRanker returns the injected override (DIP)", () => {
    const custom: RecallRanker = {
      version: "custom",
      async rank(): Promise<RankedBrainItem[]> {
        return [];
      },
    };

    expect(resolveRecallRanker(custom)).toBe(custom);
    expect(resolveRecallRanker(custom).version).toBe("custom");
  });
});
