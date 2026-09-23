import type {
  ConsensusDraftEvidence,
  ConsensusVerdictEvidence,
} from "../ledger";

import { describe, expect, it } from "vitest";

import {
  composeConsensusRoundCritique,
  hasActionableConsensusCritique,
} from "../critique";
import { CONSENSUS_PROMPT_TEXT_CAP_BYTES } from "../text";

const AXES = ["scope", "risk"];
const MARKER = "[consensus text truncated:";

function draft(
  participantId: string,
  overrides: Partial<ConsensusDraftEvidence> = {},
): ConsensusDraftEvidence {
  return {
    participantId,
    participantKind: "runner",
    runId: `run-${participantId}`,
    round: 1,
    status: "Done",
    artifactId: `artifact-${participantId}`,
    artifactText: `BODY-OF-${participantId}`,
    classification: "complete",
    stopReason: "end_turn",
    reason: null,
    ...overrides,
  };
}

function verdict(
  verifierId: string,
  targetParticipantId: string,
  overrides: Partial<ConsensusVerdictEvidence> = {},
): ConsensusVerdictEvidence {
  return {
    verifierId,
    targetParticipantId,
    round: 1,
    parseStatus: "parsed",
    verdict: "agree",
    axes: Object.fromEntries(AXES.map((axis) => [axis, true])),
    disagreements: [],
    rawOutputArtifactId: `raw-${verifierId}-${targetParticipantId}`,
    ...overrides,
  };
}

function compose(
  participants: string[],
  drafts: ConsensusDraftEvidence[],
  verdicts: ConsensusVerdictEvidence[],
  axes: string[] = AXES,
) {
  return composeConsensusRoundCritique({
    runId: "run-1",
    nodeAttemptId: "attempt-1",
    round: 1,
    participants,
    drafts,
    verdicts,
    axes,
  });
}

describe("composeConsensusRoundCritique", () => {
  it("addresses each participant's own verdict and own draft only", () => {
    const critique = compose(
      ["p1", "p2"],
      [draft("p1"), draft("p2")],
      [
        verdict("p2", "p1", {
          verdict: "disagree",
          axes: { scope: false, risk: true },
        }),
        verdict("p1", "p2"),
      ],
    );
    const p1 = critique.participantPrompts.get("p1") ?? "";
    const p2 = critique.participantPrompts.get("p2") ?? "";

    expect(p1).toContain("axis scope judged false by verifier p2");
    expect(p1).toContain("BODY-OF-p1");
    expect(p1).not.toContain("BODY-OF-p2");
    expect(p2).toContain("BODY-OF-p2");
    expect(p2).not.toContain("BODY-OF-p1");
    expect(p2).toContain("Verifier p1 gave no content criticism of p2.");
    expect(critique.actionable).toBe(true);
  });

  it("never presents a fail-closed verifier's synthetic false axes as content critique", () => {
    const failed = verdict("p2", "p1", {
      parseStatus: "invalid_json",
      verdict: "disagree",
      axes: { scope: false, risk: false },
      errorCode: "invalid_json",
    });
    const critique = compose(
      ["p1", "p2"],
      [draft("p1"), draft("p2")],
      [failed],
    );

    expect(critique.actionable).toBe(false);
    expect(critique.technicalFailures).toEqual([
      {
        verifierId: "p2",
        targetParticipantId: "p1",
        parseStatus: "invalid_json",
        errorCode: "invalid_json",
      },
    ]);
    expect(critique.participantPrompts.get("p1")).not.toContain("judged false");
  });

  it("ignores whitespace-only rows when deciding actionability", () => {
    expect(
      hasActionableConsensusCritique(
        [
          verdict("p2", "p1", {
            verdict: "disagree",
            disagreements: [{ axis: "scope", claim: " ", counterEvidence: "" }],
          }),
        ],
        AXES,
      ),
    ).toBe(false);
  });

  it("tells a partial drafter why its draft was cut, from the recorded cause", () => {
    const capped = compose(
      ["p1"],
      [
        draft("p1", {
          classification: "partial",
          stopReason: "end_turn",
          reason: "output_cap_exceeded",
          artifactText: "x".repeat(10),
        }),
      ],
      [verdict("p1", "p1", { errorCode: "draft_partial" })],
    );
    const tokens = compose(
      ["p1"],
      [
        draft("p1", {
          classification: "partial",
          stopReason: "max_tokens",
          reason: "consensus_draft_incomplete",
          artifactText: "y".repeat(7),
        }),
      ],
      [verdict("p1", "p1", { errorCode: "draft_partial" })],
    );

    expect(capped.participantPrompts.get("p1")).toContain(
      "exceeded the 1048576-byte output cap after 10 retained UTF-8 bytes",
    );
    expect(tokens.participantPrompts.get("p1")).toContain(
      "was cut by max_tokens after 7 UTF-8 bytes",
    );
    expect(capped.actionable).toBe(true);
    expect(capped.technicalFailures).toEqual([]);
  });

  it("shows at most 12 union rows, counts the rest, and bounds each field", () => {
    const rows = Array.from({ length: 15 }, (_, index) => ({
      axis: "scope",
      claim: index === 0 ? "c".repeat(2_000) : `claim-${index}`,
      counterEvidence: `evidence-${index}`,
    }));
    const critique = compose(
      ["p1", "p2"],
      [draft("p1"), draft("p2")],
      [verdict("p2", "p1", { verdict: "disagree", disagreements: rows })],
    );
    const prompt = critique.participantPrompts.get("p2") ?? "";

    expect(prompt).toContain("claim-11");
    expect(prompt).not.toContain("claim-12");
    expect(prompt).toContain("Omitted 3 rows and 0 axes.");
    expect(prompt).toContain(`${MARKER} dropped`);
    expect(prompt).toContain("cap 1024 bytes]");
  });

  it("reserves the addressed verdict before a union too large for the budget", () => {
    const ids = Array.from(
      { length: 30 },
      (_, index) => `${String(index).padStart(2, "0")}-${"v".repeat(200)}`,
    );
    const axes = Array.from({ length: 12 }, (_, index) => `axis-${index}`);
    const allFalse = Object.fromEntries(axes.map((axis) => [axis, false]));
    const critique = compose(
      ids,
      ids.map((id) => draft(id)),
      ids.map((id, index) =>
        verdict(id, ids[(index + 1) % ids.length], {
          verdict: "disagree",
          axes: allFalse,
        }),
      ),
      axes,
    );
    const prompt = critique.participantPrompts.get(ids[1]) ?? "";
    const [, afterVerdict] = prompt.split("Verdict on your previous draft:");
    const [addressed] = afterVerdict.split("Your previous draft:");
    const [, union] = prompt.split("Round critique:");

    for (const axis of axes)
      expect(addressed).toContain(`axis ${axis} judged false by verifier`);
    expect(addressed).not.toContain(MARKER);
    expect(union).toContain(MARKER);
    expect(Buffer.byteLength(prompt, "utf8")).toBeLessThanOrEqual(
      CONSENSUS_PROMPT_TEXT_CAP_BYTES + 2_048,
    );
  });

  it("separates technical verifier failures and counts those not shown", () => {
    const failures = Array.from({ length: 14 }, (_, index) =>
      verdict(`v${index}`, "p1", {
        parseStatus: "invalid_json",
        verdict: "disagree",
        axes: { scope: false, risk: false },
        errorCode: "invalid_json",
      }),
    );
    const prompt =
      compose(["p1"], [draft("p1")], failures).participantPrompts.get("p1") ??
      "";

    expect(prompt).toContain("Technical verifier failures:");
    expect(prompt).toContain("Omitted 2 technical failures.");
  });
});
