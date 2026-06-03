import type { GateVerdict } from "@/lib/db/schema";

import { describe, it, expect } from "vitest";

describe("GateVerdict.calibration", () => {
  it("should allow calibration sub-object with above_threshold outcome", () => {
    const v: GateVerdict = {
      verdict: "pass",
      confidence: 0.9,
      calibration: {
        confidenceMin: 0.8,
        rawVerdict: "pass",
        outcome: "above_threshold",
      },
    };

    expect(v.calibration?.outcome).toBe("above_threshold");
    expect(v.calibration?.confidenceMin).toBe(0.8);
    expect(v.calibration?.rawVerdict).toBe("pass");
  });

  it("should allow calibration with below_threshold outcome", () => {
    const v: GateVerdict = {
      verdict: "pass",
      confidence: 0.5,
      calibration: {
        confidenceMin: 0.8,
        rawVerdict: "pass",
        outcome: "below_threshold",
      },
    };

    expect(v.calibration?.outcome).toBe("below_threshold");
  });

  it("should allow calibration with no_confidence outcome", () => {
    const v: GateVerdict = {
      verdict: "pass",
      calibration: {
        confidenceMin: 0.8,
        rawVerdict: "pass",
        outcome: "no_confidence",
      },
    };

    expect(v.calibration?.outcome).toBe("no_confidence");
  });

  it("should allow calibration with missing_confidence_allowed outcome", () => {
    const v: GateVerdict = {
      verdict: "pass",
      calibration: {
        confidenceMin: 0.8,
        rawVerdict: "pass",
        outcome: "missing_confidence_allowed",
      },
    };

    expect(v.calibration?.outcome).toBe("missing_confidence_allowed");
  });

  it("should allow GateVerdict without calibration (optional)", () => {
    const v: GateVerdict = {
      verdict: "pass",
      confidence: 0.95,
    };

    expect(v.calibration).toBeUndefined();
  });
});
