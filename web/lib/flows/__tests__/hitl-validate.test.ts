import { describe, expect, it } from "vitest";

import {
  assertConsensusDecision,
  assertReviewDecision,
  isConsensusResolutionSchema,
  isReviewSchema,
  validateConsensusDecision,
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

const consensusSchema = {
  kind: "consensus_resolution",
  round: 1,
  allowedDecisions: [
    "pick-draft-1",
    "provide-resolution",
    "re-run-round",
    "abort",
  ],
  drafts: [{ participantLabel: "Planner A", runId: "child-run-secret" }],
};

describe("isReviewSchema", () => {
  it("is true only for a {review:true} schema", () => {
    expect(isReviewSchema(reviewSchema)).toBe(true);
    expect(isReviewSchema({ fields: [] })).toBe(false);
    expect(isReviewSchema(null)).toBe(false);
    expect(isReviewSchema(undefined)).toBe(false);
  });
});

describe("isConsensusResolutionSchema", () => {
  it("is true only for consensus resolution schemas", () => {
    expect(isConsensusResolutionSchema(consensusSchema)).toBe(true);
    expect(isConsensusResolutionSchema({ kind: "consensus" })).toBe(true);
    expect(isConsensusResolutionSchema(reviewSchema)).toBe(false);
    expect(isConsensusResolutionSchema(null)).toBe(false);
  });
});

describe("validateConsensusDecision", () => {
  it("accepts an allow-listed draft pick and canonicalizes away body ids", () => {
    const r = validateConsensusDecision(
      {
        decision: "pick-draft-1",
        draftRunId: "body-controlled",
        participantId: "body-controlled",
      },
      consensusSchema,
    );

    expect(r).toEqual({
      ok: true,
      decision: "pick-draft-1",
      response: { decision: "pick-draft-1" },
    });
  });

  it("accepts a non-empty human resolution", () => {
    const r = validateConsensusDecision(
      {
        decision: "provide-resolution",
        resolution: "Use Planner A and defer analytics.",
      },
      consensusSchema,
    );

    expect(r).toEqual({
      ok: true,
      decision: "provide-resolution",
      response: {
        decision: "provide-resolution",
        resolution: "Use Planner A and defer analytics.",
      },
    });
  });

  it("rejects undeclared decisions and empty resolutions", () => {
    expect(
      validateConsensusDecision({ decision: "pick-draft-7" }, consensusSchema)
        .ok,
    ).toBe(false);
    expect(
      validateConsensusDecision(
        { decision: "provide-resolution", resolution: "" },
        consensusSchema,
      ).ok,
    ).toBe(false);
  });

  it("assertConsensusDecision surfaces invalid consensus responses as NEEDS_INPUT", () => {
    let thrown: unknown;

    try {
      assertConsensusDecision({ decision: "abort-now" }, consensusSchema);
    } catch (err) {
      thrown = err;
    }

    expect((thrown as { code?: string } | undefined)?.code).toBe("NEEDS_INPUT");
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

// ADR-072: stored review-gate schemas carry server-state { maxLoops,
// gateAttempt } (stamped by the runner at gate creation). A rework decision
// at gateAttempt > maxLoops is refused at validate time — total allowed gate
// visits = maxLoops + 1; the engine CONFIG throw stays as the backstop.
describe("validateReviewDecision — ADR-072 loop exhaustion", () => {
  const withLoop = (maxLoops: number | null, gateAttempt: number) => ({
    ...reviewSchema,
    maxLoops,
    gateAttempt,
  });

  it("allows rework at gateAttempt = maxLoops (the last allowed rework)", () => {
    const r = validateReviewDecision({ decision: "rework" }, withLoop(2, 2));

    expect(r).toMatchObject({
      ok: true,
      decision: "rework",
      reworkTarget: "implement",
    });
  });

  it("rejects rework at gateAttempt = maxLoops + 1 (loop exhausted)", () => {
    const r = validateReviewDecision({ decision: "rework" }, withLoop(2, 3));

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("maxLoops");
  });

  it("assertReviewDecision surfaces exhaustion as NEEDS_INPUT (respond route maps it to 422)", () => {
    let thrown: unknown;

    try {
      assertReviewDecision({ decision: "rework" }, withLoop(1, 2));
    } catch (err) {
      thrown = err;
    }

    expect((thrown as { code?: string } | undefined)?.code).toBe("NEEDS_INPUT");
  });

  it("never blocks approve, even past the boundary", () => {
    const r = validateReviewDecision({ decision: "approve" }, withLoop(1, 5));

    expect(r).toEqual({ ok: true, decision: "approve" });
  });

  it("does not fire when maxLoops is null (node declares no rework)", () => {
    const r = validateReviewDecision({ decision: "rework" }, withLoop(null, 7));

    expect(r).toMatchObject({ ok: true, decision: "rework" });
  });

  it("does not fire on a legacy schema without the loop fields", () => {
    const r = validateReviewDecision({ decision: "rework" }, reviewSchema);

    expect(r).toMatchObject({ ok: true, decision: "rework" });
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
