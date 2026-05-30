import { describe, expect, it } from "vitest";

import {
  isReviewSchema,
  validateHitlResponse,
  validateReviewDecision,
} from "@/lib/flows/hitl-validate";

const reviewSchema = {
  review: true,
  allowedDecisions: ["approve", "rework"],
  transitions: { approve: "done", rework: "implement" },
  reworkTargets: ["implement"],
  workspacePolicies: ["keep"],
};

describe("isReviewSchema", () => {
  it("is true only for a {review:true} schema", () => {
    expect(isReviewSchema(reviewSchema)).toBe(true);
    expect(isReviewSchema({ fields: [] })).toBe(false);
    expect(isReviewSchema(null)).toBe(false);
    expect(isReviewSchema(undefined)).toBe(false);
  });
});

describe("validateReviewDecision", () => {
  it("accepts an approve (terminal) decision with no rework fields", () => {
    const r = validateReviewDecision({ decision: "approve" }, reviewSchema);

    expect(r).toEqual({ ok: true, decision: "approve" });
  });

  it("accepts a rework decision and defaults workspacePolicy to the first allowed", () => {
    const r = validateReviewDecision({ decision: "rework" }, reviewSchema);

    expect(r).toEqual({
      ok: true,
      decision: "rework",
      workspacePolicy: "keep",
      reworkTarget: "implement",
    });
  });

  it("accepts a rework decision with an explicit allowed workspacePolicy", () => {
    const r = validateReviewDecision(
      { decision: "rework", workspacePolicy: "keep" },
      reviewSchema,
    );

    expect(r).toMatchObject({ ok: true, workspacePolicy: "keep" });
  });

  it("rejects an undeclared decision", () => {
    const r = validateReviewDecision({ decision: "bogus" }, reviewSchema);

    expect(r.ok).toBe(false);
  });

  it("rejects a prototype-key decision (toString)", () => {
    const r = validateReviewDecision(
      { decision: "toString" },
      { ...reviewSchema, allowedDecisions: ["approve", "toString"] },
    );

    // "toString" is in allowedDecisions but has NO own transition → rejected.
    expect(r.ok).toBe(false);
  });

  it("rejects an unallowed workspacePolicy on rework", () => {
    const r = validateReviewDecision(
      { decision: "rework", workspacePolicy: "fresh-attempt" },
      reviewSchema,
    );

    expect(r.ok).toBe(false);
  });

  it("rejects a non-object response", () => {
    expect(validateReviewDecision("nope", reviewSchema).ok).toBe(false);
  });
});

describe("validateHitlResponse still works for form schemas", () => {
  it("validates a form field", () => {
    const ok = validateHitlResponse(
      { name: "x" },
      { fields: [{ name: "name", type: "string", required: true }] },
    );

    expect(ok.ok).toBe(true);
  });
});
