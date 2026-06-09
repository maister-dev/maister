import { describe, expect, it } from "vitest";

import { isHumanReviewGate } from "@/lib/flows/review-gate";

describe("isHumanReviewGate", () => {
  it("is true for a human gate whose schema declares review", () => {
    expect(
      isHumanReviewGate({
        kind: "human",
        schema: { review: true, allowedDecisions: ["approve", "rework"] },
      }),
    ).toBe(true);
  });

  it("is false for a human gate whose schema does not declare review", () => {
    expect(
      isHumanReviewGate({ kind: "human", schema: { review: false } }),
    ).toBe(false);
    expect(isHumanReviewGate({ kind: "human", schema: {} })).toBe(false);
  });

  it("is false for a permission gate", () => {
    expect(
      isHumanReviewGate({ kind: "permission", schema: { review: true } }),
    ).toBe(false);
  });

  it("is false for a form gate", () => {
    expect(
      isHumanReviewGate({
        kind: "form",
        schema: { fields: [{ name: "intent" }] },
      }),
    ).toBe(false);
  });

  it("is false when there is no pending HITL", () => {
    expect(isHumanReviewGate(null)).toBe(false);
  });

  it("is false for a non-object schema", () => {
    expect(isHumanReviewGate({ kind: "human", schema: null })).toBe(false);
  });
});
