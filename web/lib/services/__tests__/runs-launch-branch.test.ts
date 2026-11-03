import { describe, expect, it } from "vitest";

import { resolvePromotionMode } from "@/lib/services/runs";

describe("resolvePromotionMode — SET / CLEAR / re-set (M18 §3.4)", () => {
  it("uses the project promotion_mode when set and no launch override", () => {
    expect(resolvePromotionMode({ projectPromotionMode: "pull_request" })).toBe(
      "pull_request",
    );
  });

  it("accepts rebase_merge project promotion mode", () => {
    expect(resolvePromotionMode({ projectPromotionMode: "rebase_merge" })).toBe(
      "rebase_merge",
    );
  });

  it("falls back to local_merge when the project promotion_mode is cleared (null)", () => {
    expect(resolvePromotionMode({ projectPromotionMode: null })).toBe(
      "local_merge",
    );
  });

  it("falls back to local_merge when both inputs are absent", () => {
    expect(resolvePromotionMode({})).toBe("local_merge");
  });

  it("prefers a launch override over a cleared project value", () => {
    expect(
      resolvePromotionMode({
        launchOverride: "pull_request",
        projectPromotionMode: null,
      }),
    ).toBe("pull_request");
  });

  it("re-set: project value re-applied when no launch override", () => {
    expect(
      resolvePromotionMode({
        launchOverride: null,
        projectPromotionMode: "pull_request",
      }),
    ).toBe("pull_request");
  });
});
