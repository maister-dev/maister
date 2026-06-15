import { describe, expect, it } from "vitest";

import { edgeOutcomeStyle, isBackEdgeOutcome } from "@/lib/flows/edge-style";

describe("edgeOutcomeStyle", () => {
  it("renders back-edge outcomes dashed + animated + amber (--attention)", () => {
    for (const outcome of ["rework", "takeover", "reject"]) {
      const s = edgeOutcomeStyle(outcome);

      expect(s.animated).toBe(true);
      expect(s.style.strokeDasharray).toBeDefined();
      expect(s.style.stroke).toContain("attention");
    }
  });

  it("renders failure outcomes solid red (--danger)", () => {
    for (const outcome of ["failure", "fail", "FAILED"]) {
      const s = edgeOutcomeStyle(outcome);

      expect(s.animated).toBe(false);
      expect(s.style.strokeDasharray).toBeUndefined();
      expect(s.style.stroke).toContain("danger");
    }
  });

  it("renders forward/success outcomes solid green-gray (--edge-success)", () => {
    for (const outcome of [
      "success",
      "default",
      "approve",
      "custom_exit",
      "",
    ]) {
      const s = edgeOutcomeStyle(outcome);

      expect(s.animated).toBe(false);
      expect(s.style.strokeDasharray).toBeUndefined();
      expect(s.style.stroke).toContain("edge-success");
    }
  });
});

describe("isBackEdgeOutcome", () => {
  it("classifies back-edges case-insensitively and trimmed", () => {
    expect(isBackEdgeOutcome(" Rework ")).toBe(true);
    expect(isBackEdgeOutcome("TAKEOVER")).toBe(true);
    expect(isBackEdgeOutcome("reject")).toBe(true);
    expect(isBackEdgeOutcome("success")).toBe(false);
    expect(isBackEdgeOutcome("approve")).toBe(false);
    expect(isBackEdgeOutcome("failure")).toBe(false);
  });
});
