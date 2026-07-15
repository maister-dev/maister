import { describe, expect, it } from "vitest";

import {
  buildPromotionRequestBody,
  promotionBlockReason,
} from "@/lib/runs/promotion-operation";

const input = {
  targetBranch: "main",
  deliveryPolicy: {
    strategy: "merge" as const,
    push: "on_success" as const,
    trigger: "auto_on_ready" as const,
    targetBranch: "main",
  },
  mode: "rebase_merge" as const,
  reviewedTargetCommit: "target-tip",
  canPromote: true,
  reviewReady: true,
  diffTruncated: false,
  legacyNeedsRelaunch: false,
};

describe("promotion operation", () => {
  it("builds the same guarded manual payload for every promotion entry point", () => {
    expect(buildPromotionRequestBody(input)).toEqual({
      targetBranch: "main",
      deliveryPolicyOverride: {
        strategy: "rebase_merge",
        push: "on_success",
        trigger: "manual",
        targetBranch: "main",
      },
      reviewedTargetCommit: "target-tip",
    });
  });

  it.each([
    ["missing target", { targetBranch: null }, "missing-target"],
    ["permission denied", { canPromote: false }, "not-authorized"],
    ["readiness blocked", { reviewReady: false }, "review-not-ready"],
    ["partial diff", { diffTruncated: true }, "diff-truncated"],
    [
      "missing reviewed commit",
      { reviewedTargetCommit: null },
      "missing-review-target",
    ],
    ["legacy run", { legacyNeedsRelaunch: true }, "legacy-needs-relaunch"],
  ] as const)("refuses a %s promotion", (_name, override, reason) => {
    expect(promotionBlockReason({ ...input, ...override })).toBe(reason);
  });

  it("carries autoFinalize only for ai_rebase_merge (ADR-140 decision 19)", () => {
    const aiOn = buildPromotionRequestBody({
      ...input,
      mode: "ai_rebase_merge",
      autoFinalize: true,
    });

    expect(aiOn?.autoFinalize).toBe(true);

    // autoFinalize is a no-op for any other mode — never leaked into the body.
    const rebaseWithFlag = buildPromotionRequestBody({
      ...input,
      mode: "rebase_merge",
      autoFinalize: true,
    });

    expect(rebaseWithFlag).not.toHaveProperty("autoFinalize");

    // ai_rebase_merge default (flag absent/false) → two-step, no autoFinalize.
    const aiOff = buildPromotionRequestBody({
      ...input,
      mode: "ai_rebase_merge",
    });

    expect(aiOff).not.toHaveProperty("autoFinalize");
  });
});
