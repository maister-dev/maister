import { describe, expect, it } from "vitest";

import { countPlanReviewDecisionReworks } from "@/lib/flows/graph/runner-graph";

describe("countPlanReviewDecisionReworks", () => {
  it("counts only prior decision-driven reworks for the current review node", () => {
    const count = countPlanReviewDecisionReworks(
      [
        {
          stepId: "review_backend",
          schema: { planReview: { answersVar: "plan_answers" } },
          response: { plan_answers: { answers: [{ decisionId: "db" }] } },
        },
        {
          stepId: "review_frontend",
          schema: { planReview: { answersVar: "plan_answers" } },
          response: { plan_answers: { answers: [{ decisionId: "ui" }] } },
        },
        {
          stepId: "review_backend",
          schema: { planReview: { answersVar: "plan_answers" } },
          response: { plan_answers: { answers: [] } },
        },
      ],
      "review_backend",
    );

    expect(count).toBe(1);
  });
});
