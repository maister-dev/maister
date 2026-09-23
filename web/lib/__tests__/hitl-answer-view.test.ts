import { describe, expect, it } from "vitest";

import { projectHitlAnswer } from "@/lib/hitl-answer-view";

const stored = {
  kind: "form",
  responseIsNotNull: true,
  respondedAt: null,
} as const;

describe("stored HITL answer projection", () => {
  it("does not expose private keys nested in structured answers", () => {
    expect(
      projectHitlAnswer({
        ...stored,
        response: { fields: [{ value: "yes", _delivery: "private" }] },
      }),
    ).toEqual({ answerState: "answer_stored", storedResponse: null });
  });

  it("withholds review, consensus, and mismatched confidence payloads", () => {
    for (const schema of [{ review: true }, { kind: "consensus_resolution" }]) {
      expect(
        projectHitlAnswer({
          ...stored,
          kind: "human",
          schema,
          response: { decision: "approve" },
        }).storedResponse,
      ).toBeNull();
    }
    expect(
      projectHitlAnswer({
        ...stored,
        kind: "human",
        confidence: 0.8,
        response: { answer: "yes", confidence: 0.9 },
      }).storedResponse,
    ).toBeNull();
  });

  it("preserves scalar, array, and JSON null answers while distinguishing SQL NULL", () => {
    for (const response of ["yes", ["a", "b"], null]) {
      expect(projectHitlAnswer({ ...stored, response })).toEqual({
        answerState: "answer_stored",
        storedResponse: { response },
      });
    }
    expect(
      projectHitlAnswer({
        ...stored,
        response: null,
        responseIsNotNull: false,
      }),
    ).toEqual({ answerState: "open", storedResponse: null });
  });
});
