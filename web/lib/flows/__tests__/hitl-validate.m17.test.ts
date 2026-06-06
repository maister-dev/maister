import { describe, expect, it } from "vitest";

import { validateReviewDecision } from "@/lib/flows/hitl-validate";

/**
 * M17 ADR-050: human_confidence assessment taxonomy tests
 * Confidence is a real in [0,1] inclusive, optional, captured at response time
 * and echoed into the response jsonb.
 */

describe("validateReviewDecision — M17 confidence field", () => {
  const reviewSchema = {
    review: true,
    allowedDecisions: ["approve", "rework"],
    transitions: { approve: "done", rework: "implement" },
    reworkTargets: ["implement"],
    workspacePolicies: ["keep"],
  };

  it("accepts confidence: 0 (fully uncertain)", () => {
    const r = validateReviewDecision(
      { decision: "approve", confidence: 0 },
      reviewSchema,
    );

    expect(r.ok).toBe(true);
    expect((r as any).confidence).toBe(0);
  });

  it("accepts confidence: 0.5 (half confident)", () => {
    const r = validateReviewDecision(
      { decision: "approve", confidence: 0.5 },
      reviewSchema,
    );

    expect(r.ok).toBe(true);
    expect((r as any).confidence).toBe(0.5);
  });

  it("accepts confidence: 1 (fully confident)", () => {
    const r = validateReviewDecision(
      { decision: "approve", confidence: 1 },
      reviewSchema,
    );

    expect(r.ok).toBe(true);
    expect((r as any).confidence).toBe(1);
  });

  it("rejects confidence > 1", () => {
    const r = validateReviewDecision(
      { decision: "approve", confidence: 1.5 },
      reviewSchema,
    );

    expect(r.ok).toBe(false);
  });

  it("rejects confidence < 0", () => {
    const r = validateReviewDecision(
      { decision: "approve", confidence: -0.1 },
      reviewSchema,
    );

    expect(r.ok).toBe(false);
  });

  it("rejects confidence: NaN", () => {
    const r = validateReviewDecision(
      { decision: "approve", confidence: NaN },
      reviewSchema,
    );

    expect(r.ok).toBe(false);
  });

  it("rejects confidence as a string", () => {
    const r = validateReviewDecision(
      { decision: "approve", confidence: "high" as any },
      reviewSchema,
    );

    expect(r.ok).toBe(false);
  });

  it("allows absent confidence (undefined -> undefined)", () => {
    const r = validateReviewDecision({ decision: "approve" }, reviewSchema);

    expect(r.ok).toBe(true);
    expect((r as any).confidence).toBeUndefined();
  });

  it("preserves confidence on rework decision", () => {
    const r = validateReviewDecision(
      { decision: "rework", confidence: 0.3 },
      reviewSchema,
    );

    expect(r.ok).toBe(true);
    expect((r as any).confidence).toBe(0.3);
    expect((r as any).workspacePolicy).toBe("keep");
  });

  it("preserves confidence with explicit workspacePolicy", () => {
    const r = validateReviewDecision(
      { decision: "rework", workspacePolicy: "keep", confidence: 0.8 },
      reviewSchema,
    );

    expect(r.ok).toBe(true);
    expect((r as any).confidence).toBe(0.8);
  });
});
