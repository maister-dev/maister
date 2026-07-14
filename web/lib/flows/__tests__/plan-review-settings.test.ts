import { describe, expect, it } from "vitest";

import { humanSettingsSchema } from "@/lib/config.schema";

const planReviewSettings = {
  plan_document_artifact: "plan-document",
  plan_review_artifact: "plan-review",
  comments_var: "plan_review_comments",
  answers_var: "plan_review_answers",
  rework_transition: "rework",
  max_decision_reworks: 2,
};

describe("human settings plan_review capability", () => {
  it("accepts an explicit bounded Plan-review declaration", () => {
    expect(
      humanSettingsSchema.safeParse({ plan_review: planReviewSettings }).success,
    ).toBe(true);
  });

  it("refuses an unbounded or incomplete declaration", () => {
    expect(
      humanSettingsSchema.safeParse({
        plan_review: { ...planReviewSettings, max_decision_reworks: 0 },
      }).success,
    ).toBe(false);
    expect(
      humanSettingsSchema.safeParse({
        plan_review: { ...planReviewSettings, rework_transition: undefined },
      }).success,
    ).toBe(false);
  });
});
