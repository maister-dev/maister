import { describe, expect, it } from "vitest";

import { calibrateVerdict } from "@/lib/flows/graph/gates-exec";

describe("calibrateVerdict", () => {
  describe("no threshold configured (confidence_min undefined)", () => {
    it("pass verdict with any confidence → pass, no calibration (legacy)", () => {
      const parsed = { verdict: "pass", confidence: 0.9 };
      const result = calibrateVerdict(parsed, undefined);

      expect(result.pass).toBe(true);
      expect(result.calibration).toBeUndefined();
    });

    it("pass verdict with no confidence → pass, no calibration (legacy)", () => {
      const parsed = { verdict: "pass" };
      const result = calibrateVerdict(parsed, undefined);

      expect(result.pass).toBe(true);
      expect(result.calibration).toBeUndefined();
    });

    it("pass verdict with allow_missing_confidence true → pass, no calibration (legacy)", () => {
      const parsed = { verdict: "pass" };
      const result = calibrateVerdict(parsed, {
        allow_missing_confidence: true,
      });

      expect(result.pass).toBe(true);
      expect(result.calibration).toBeUndefined();
    });
  });

  describe("threshold set (confidence_min defined), confidence present and >= min", () => {
    it("confidence above threshold → pass with above_threshold outcome", () => {
      const parsed = { verdict: "pass", confidence: 0.9 };
      const result = calibrateVerdict(parsed, { confidence_min: 0.7 });

      expect(result.pass).toBe(true);
      expect(result.calibration).toEqual({
        confidenceMin: 0.7,
        rawVerdict: "pass",
        outcome: "above_threshold",
      });
    });

    it("confidence equal to threshold → pass with above_threshold outcome", () => {
      const parsed = { verdict: "pass", confidence: 0.7 };
      const result = calibrateVerdict(parsed, { confidence_min: 0.7 });

      expect(result.pass).toBe(true);
      expect(result.calibration).toEqual({
        confidenceMin: 0.7,
        rawVerdict: "pass",
        outcome: "above_threshold",
      });
    });

    it("threshold of 0 with confidence 0 → pass with above_threshold outcome", () => {
      const parsed = { verdict: "pass", confidence: 0 };
      const result = calibrateVerdict(parsed, { confidence_min: 0 });

      expect(result.pass).toBe(true);
      expect(result.calibration).toEqual({
        confidenceMin: 0,
        rawVerdict: "pass",
        outcome: "above_threshold",
      });
    });
  });

  describe("threshold set, confidence present and < min", () => {
    it("confidence below threshold → fail with below_threshold outcome", () => {
      const parsed = { verdict: "pass", confidence: 0.5 };
      const result = calibrateVerdict(parsed, { confidence_min: 0.7 });

      expect(result.pass).toBe(false);
      expect(result.calibration).toEqual({
        confidenceMin: 0.7,
        rawVerdict: "pass",
        outcome: "below_threshold",
      });
    });

    it("confidence slightly below threshold → fail with below_threshold outcome", () => {
      const parsed = { verdict: "pass", confidence: 0.69 };
      const result = calibrateVerdict(parsed, { confidence_min: 0.7 });

      expect(result.pass).toBe(false);
      expect(result.calibration).toEqual({
        confidenceMin: 0.7,
        rawVerdict: "pass",
        outcome: "below_threshold",
      });
    });
  });

  describe("threshold set, confidence absent", () => {
    it("allow_missing_confidence false (default) → fail with no_confidence outcome", () => {
      const parsed = { verdict: "pass" };
      const result = calibrateVerdict(parsed, {
        confidence_min: 0.7,
        allow_missing_confidence: false,
      });

      expect(result.pass).toBe(false);
      expect(result.calibration).toEqual({
        confidenceMin: 0.7,
        rawVerdict: "pass",
        outcome: "no_confidence",
      });
    });

    it("allow_missing_confidence undefined (default) → fail with no_confidence outcome", () => {
      const parsed = { verdict: "pass" };
      const result = calibrateVerdict(parsed, { confidence_min: 0.7 });

      expect(result.pass).toBe(false);
      expect(result.calibration).toEqual({
        confidenceMin: 0.7,
        rawVerdict: "pass",
        outcome: "no_confidence",
      });
    });

    it("allow_missing_confidence true → pass with missing_confidence_allowed outcome", () => {
      const parsed = { verdict: "pass" };
      const result = calibrateVerdict(parsed, {
        confidence_min: 0.7,
        allow_missing_confidence: true,
      });

      expect(result.pass).toBe(true);
      expect(result.calibration).toEqual({
        confidenceMin: 0.7,
        rawVerdict: "pass",
        outcome: "missing_confidence_allowed",
      });
    });
  });

  describe("edge cases: threshold = 0", () => {
    it("threshold 0 with allow_missing_confidence true and no confidence → pass", () => {
      const parsed = { verdict: "pass" };
      const result = calibrateVerdict(parsed, {
        confidence_min: 0,
        allow_missing_confidence: true,
      });

      expect(result.pass).toBe(true);
      expect(result.calibration).toEqual({
        confidenceMin: 0,
        rawVerdict: "pass",
        outcome: "missing_confidence_allowed",
      });
    });

    it("threshold 0 with allow_missing_confidence false and no confidence → fail no_confidence", () => {
      const parsed = { verdict: "pass" };
      const result = calibrateVerdict(parsed, {
        confidence_min: 0,
        allow_missing_confidence: false,
      });

      expect(result.pass).toBe(false);
      expect(result.calibration).toEqual({
        confidenceMin: 0,
        rawVerdict: "pass",
        outcome: "no_confidence",
      });
    });
  });

  describe("threshold set, confidence out of 0..1 domain → fail-closed invalid_confidence", () => {
    it.each([
      2,
      1.5,
      -0.5,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      NaN,
    ])(
      "confidence %p (out of domain) → fail with invalid_confidence outcome",
      (confidence) => {
        const parsed = { verdict: "pass", confidence };
        const result = calibrateVerdict(parsed, { confidence_min: 0.8 });

        expect(result.pass).toBe(false);
        expect(result.calibration).toEqual({
          confidenceMin: 0.8,
          rawVerdict: "pass",
          outcome: "invalid_confidence",
        });
      },
    );

    it("out-of-domain confidence is NOT rescued by allow_missing_confidence (present, just invalid)", () => {
      const parsed = { verdict: "pass", confidence: 2 };
      const result = calibrateVerdict(parsed, {
        confidence_min: 0.8,
        allow_missing_confidence: true,
      });

      expect(result.pass).toBe(false);
      expect(result.calibration?.outcome).toBe("invalid_confidence");
    });

    it("boundary: confidence exactly 1 is in-domain → above_threshold", () => {
      const parsed = { verdict: "pass", confidence: 1 };
      const result = calibrateVerdict(parsed, { confidence_min: 0.8 });

      expect(result.pass).toBe(true);
      expect(result.calibration?.outcome).toBe("above_threshold");
    });
  });

  describe("various pass verdicts normalized", () => {
    it.each([
      "pass",
      "passed",
      "approve",
      "approved",
      "ok",
      "success",
      "succeeded",
      "ready",
    ])("verdict '%s' → pass, rawVerdict preserved as-is", (verdict) => {
      const parsed = { verdict, confidence: 0.8 };
      const result = calibrateVerdict(parsed, { confidence_min: 0.7 });

      expect(result.pass).toBe(true);
      expect(result.calibration?.rawVerdict).toBe(verdict);
      expect(result.calibration?.outcome).toBe("above_threshold");
    });
  });

  describe("additional fields in parsed verdict", () => {
    it("preserves additional fields (reasons, recommendedAction) in parsed", () => {
      const parsed = {
        verdict: "pass",
        confidence: 0.8,
        reasons: ["all checks passed"],
        recommendedAction: "merge",
      };
      const result = calibrateVerdict(parsed, { confidence_min: 0.7 });

      expect(result.pass).toBe(true);
      expect(result.calibration?.rawVerdict).toBe("pass");
      // NOTE: calibrateVerdict only returns {pass, calibration?}; additional parsed fields
      // remain in the original parsed object and are handled by the caller
    });
  });
});
