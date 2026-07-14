import { describe, expect, it } from "vitest";

import {
  parsePlanReviewContract,
  PLAN_REVIEW_MAX_DECISIONS,
} from "@/lib/flows/plan-review-contract";

const validContract = {
  schemaVersion: 1,
  plan: {
    title: "Typed Plan review",
    documentArtifact: "plan-document",
  },
  assumptions: [
    {
      id: "existing-runtime",
      statement: "The graph runtime remains the continuation owner.",
      defaultDecision: { id: "preserve", label: "Preserve graph ownership" },
      impact: "No ACP decision protocol is added.",
      blocking: false,
    },
  ],
  decisions: [
    {
      id: "external-authority",
      question: "Can an external token choose a blocker option?",
      options: [
        {
          id: "session-only",
          label: "Keep session authority",
          consequences: "External tokens cannot answer the request.",
        },
        {
          id: "token-authority",
          label: "Allow token authority",
          consequences: "Tokens could alter the plan.",
        },
      ],
      recommendation: "session-only",
      blocking: true,
    },
  ],
};

describe("PlanReviewV1 contract", () => {
  it("accepts a bounded strict contract and retains its stable identifiers", () => {
    const contract = parsePlanReviewContract(validContract);

    expect(contract.plan.documentArtifact).toBe("plan-document");
    expect(contract.assumptions[0]?.id).toBe("existing-runtime");
    expect(contract.decisions[0]?.options.map((option) => option.id)).toEqual([
      "session-only",
      "token-authority",
    ]);
  });

  it("refuses unknown fields, duplicate ids, and recommendations outside the option allow-list", () => {
    expect(() =>
      parsePlanReviewContract({
        ...validContract,
        unexpected: true,
      }),
    ).toThrow();

    expect(() =>
      parsePlanReviewContract({
        ...validContract,
        decisions: [
          {
            ...validContract.decisions[0],
            id: "existing-runtime",
            recommendation: "missing-option",
          },
        ],
      }),
    ).toThrow();
  });

  it("refuses a blocker set beyond the declared V1 bound", () => {
    const decisions = Array.from({ length: PLAN_REVIEW_MAX_DECISIONS + 1 }, (_, index) => ({
      ...validContract.decisions[0],
      id: `decision-${index}`,
    }));

    expect(() =>
      parsePlanReviewContract({ ...validContract, decisions }),
    ).toThrow();
  });
});
