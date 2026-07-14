import { describe, expect, it } from "vitest";

import {
  assertReviewFeedbackPresent,
  reviewFeedbackFingerprint,
} from "@/lib/review-comments/feedback-packet";

const reviewSchema = {
  review: true,
  allowedDecisions: ["approve", "rework"],
  transitions: { approve: "done", rework: "fix" },
  reworkTargets: ["fix"],
  workspacePolicies: ["keep"],
  commentsVar: "review_comments",
};

describe("review feedback packet", () => {
  it("derives a stable digest from the exact delivery-relevant packet fields", () => {
    const packet = {
      target: { nodeId: "fix", commentsVar: "review_comments" },
      openThreadIds: ["thread-a", "thread-b"],
      gateChatMessageCount: 2,
      payload: "Fix the error path.\n\n## Review comments",
    };

    expect(reviewFeedbackFingerprint(packet)).toBe(
      reviewFeedbackFingerprint({ ...packet }),
    );
    expect(
      reviewFeedbackFingerprint({ ...packet, openThreadIds: ["thread-b"] }),
    ).not.toBe(reviewFeedbackFingerprint(packet));
  });

  it("requires a summary or an open thread before rework can be claimed", () => {
    const basePacket = {
      fingerprint: "sha256:test",
      target: { nodeId: "fix", commentsVar: "review_comments" },
      openThreadIds: [],
      resolvedThreadCount: 1,
      gateChatMessageCount: 0,
      payload: "",
    };
    const response = { decision: "rework", workspacePolicy: "keep" };

    expect(() =>
      assertReviewFeedbackPresent({
        packet: basePacket,
        schema: reviewSchema,
        response,
      }),
    ).toThrow("feedback summary or an open review thread");

    expect(() =>
      assertReviewFeedbackPresent({
        packet: { ...basePacket, openThreadIds: ["thread-a"] },
        schema: reviewSchema,
        response,
      }),
    ).not.toThrow();
  });
});
