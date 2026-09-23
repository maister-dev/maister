import { describe, expect, it } from "vitest";

import { publicHitlRespondDetails } from "@/lib/hitl-response-error";

describe("public HITL refusal details", () => {
  it("keeps only the reason and a valid prompt-owner diagnostic", () => {
    expect(
      publicHitlRespondDetails({
        reason: "prompt_owner_invariant",
        causeCode: "output_not_consumed",
        hostSessionId: "private-session",
      }),
    ).toEqual({
      reason: "prompt_owner_invariant",
      causeCode: "output_not_consumed",
    });
  });

  it("omits a diagnostic on other reasons and rejects unknown reasons", () => {
    expect(
      publicHitlRespondDetails({
        reason: "permission_resume_in_flight",
        causeCode: "adapter_missing",
      }),
    ).toEqual({ reason: "permission_resume_in_flight" });
    expect(
      publicHitlRespondDetails({
        reason: "prompt_owner_deferred",
        causeCode: "invalid diagnostic",
      }),
    ).toEqual({ reason: "prompt_owner_deferred" });
    expect(
      publicHitlRespondDetails({ reason: "internal_only" }),
    ).toBeUndefined();
  });
});
