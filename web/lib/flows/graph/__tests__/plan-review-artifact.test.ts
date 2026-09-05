import { describe, expect, it } from "vitest";

import {
  parsePlanReviewBytes,
  planReviewOutputBindings,
} from "../plan-review-artifact";

function validContract(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    plan: { title: "Typed review", documentArtifact: "plan-document" },
    assumptions: [],
    decisions: [
      {
        id: "runtime",
        question: "Which runtime?",
        options: [
          {
            id: "node",
            label: "Node",
            consequences: "Use the existing runtime.",
          },
          {
            id: "bun",
            label: "Bun",
            consequences: "Add a new runtime.",
          },
        ],
        recommendation: "node",
        blocking: true,
      },
    ],
  };
}

describe("plan-review runtime object contract", () => {
  it("allocates deterministic, distinct output objects without a path", () => {
    const first = planReviewOutputBindings({
      runId: "run-1",
      nodeAttemptId: "attempt-1",
      assignmentId: "assignment-1",
    });
    const replay = planReviewOutputBindings({
      runId: "run-1",
      nodeAttemptId: "attempt-1",
      assignmentId: "assignment-1",
    });
    const resumed = planReviewOutputBindings({
      runId: "run-1",
      nodeAttemptId: "attempt-1",
      assignmentId: "assignment-2",
    });

    expect(replay).toEqual(first);
    expect(resumed.planDocument.objectId).not.toBe(first.planDocument.objectId);
    expect(resumed.planReview.objectId).not.toBe(first.planReview.objectId);
    expect(first.planDocument.objectId).not.toBe(first.planReview.objectId);
    expect(first.planDocument.envName).toBe("MAISTER_PLAN_DOCUMENT_FILE");
    expect(first.planReview.envName).toBe("MAISTER_PLAN_REVIEW_FILE");
    expect(first.planDocument).not.toHaveProperty("path");
    expect(first.planReview).not.toHaveProperty("path");
  });

  it("parses V1 and fails explicitly for malformed or invalid contracts", () => {
    const parsed = parsePlanReviewBytes(
      new TextEncoder().encode(JSON.stringify(validContract())),
    );

    expect(parsed.decisions).toHaveLength(1);
    expect(() =>
      parsePlanReviewBytes(new TextEncoder().encode("{not-json")),
    ).toThrowError(expect.objectContaining({ code: "CONFIG" }));
    expect(() =>
      parsePlanReviewBytes(
        new TextEncoder().encode(JSON.stringify({ schemaVersion: 1 })),
      ),
    ).toThrowError(expect.objectContaining({ code: "CONFIG" }));
  });
});
