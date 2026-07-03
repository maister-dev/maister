import { describe, expect, it } from "vitest";

import {
  normalizeBrainAutonomyPolicy,
  resolveBrainAutonomyDecision,
} from "@/lib/brain/autonomy";

describe("Brain autonomy policy (T12.1)", () => {
  it("defaults every proposal kind/blast radius to manual", () => {
    expect(resolveBrainAutonomyDecision({}, "rule", "low")).toBe("manual");
    expect(resolveBrainAutonomyDecision({}, "flow", "medium")).toBe("manual");
    expect(resolveBrainAutonomyDecision({}, "roadmap", "high")).toBe("manual");
  });

  it("allows auto_draft only through explicit policy keys", () => {
    const policy = normalizeBrainAutonomyPolicy({
      "rule.low": "auto_draft",
    });

    expect(resolveBrainAutonomyDecision(policy, "rule", "low")).toBe(
      "auto_draft",
    );
    expect(resolveBrainAutonomyDecision(policy, "rule", "medium")).toBe(
      "manual",
    );
  });

  it("rejects auto_publish and malformed policy keys", () => {
    expect(() =>
      normalizeBrainAutonomyPolicy({ "rule.low": "auto_publish" }),
    ).toThrow(/auto_publish/);
    expect(() =>
      normalizeBrainAutonomyPolicy({ "plugin.low": "auto_draft" }),
    ).toThrow(/plugin\.low/);
  });
});
