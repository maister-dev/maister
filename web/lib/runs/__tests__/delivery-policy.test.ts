import { describe, expect, it } from "vitest";

import {
  defaultDeliveryPolicy,
  resolveDeliveryPolicy,
  switchDeliveryPolicyToManual,
} from "@/lib/runs/delivery-policy";

describe("delivery policy resolution", () => {
  it("maps null project defaults through the legacy local_merge compatibility mode", () => {
    expect(
      resolveDeliveryPolicy({
        projectDefault: null,
        projectPromotionMode: "local_merge",
        projectMainBranch: "main",
      }),
    ).toEqual({
      strategy: "merge",
      push: "never",
      trigger: "manual",
      targetBranch: "main",
    });
  });

  it("maps legacy pull_request defaults to pull_request strategy", () => {
    expect(
      resolveDeliveryPolicy({
        projectDefault: null,
        projectPromotionMode: "pull_request",
        projectMainBranch: "trunk",
      }),
    ).toEqual({
      strategy: "pull_request",
      push: "never",
      trigger: "manual",
      targetBranch: "trunk",
    });
  });

  it("maps legacy rebase_merge defaults to rebase_merge strategy", () => {
    expect(
      resolveDeliveryPolicy({
        projectDefault: null,
        projectPromotionMode: "rebase_merge",
        projectMainBranch: "release",
      }),
    ).toEqual({
      strategy: "rebase_merge",
      push: "never",
      trigger: "manual",
      targetBranch: "release",
    });
  });

  it("lets launch overrides replace only the specified fields", () => {
    expect(
      resolveDeliveryPolicy({
        projectDefault: {
          strategy: "merge",
          push: "never",
          trigger: "manual",
          targetBranch: "main",
        },
        launchOverride: {
          strategy: "ai_rebase_merge",
          trigger: "auto_on_ready",
        },
        projectMainBranch: "main",
      }),
    ).toEqual({
      strategy: "ai_rebase_merge",
      push: "never",
      trigger: "auto_on_ready",
      targetBranch: "main",
    });
  });

  it("switches only the trigger when cancelling auto delivery", () => {
    expect(
      switchDeliveryPolicyToManual({
        strategy: "rebase_merge",
        push: "on_success",
        trigger: "auto_on_ready",
        targetBranch: "release",
      }),
    ).toEqual({
      strategy: "rebase_merge",
      push: "on_success",
      trigger: "manual",
      targetBranch: "release",
    });
  });
});

describe("defaultDeliveryPolicy", () => {
  it("uses merge/manual/no-push and the project main branch", () => {
    expect(defaultDeliveryPolicy("main")).toEqual({
      strategy: "merge",
      push: "never",
      trigger: "manual",
      targetBranch: "main",
    });
  });
});
