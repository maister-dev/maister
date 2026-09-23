import { describe, expect, it } from "vitest";

import {
  consensusDraftForDecision,
  consensusPartialCause,
  decodeConsensusResolutionSchema,
  isConsensusDraftPickable,
} from "@/lib/flows/consensus-resolution";

describe("decodeConsensusResolutionSchema", () => {
  it("is null for anything that is not a consensus resolution", () => {
    expect(decodeConsensusResolutionSchema(null)).toBeNull();
    expect(decodeConsensusResolutionSchema({ kind: "form" })).toBeNull();
  });

  it("keeps stable slots and falls back to the positional allow-listed pick", () => {
    const decoded = decodeConsensusResolutionSchema({
      kind: "consensus_resolution",
      round: 2,
      allowedDecisions: ["pick-draft-1", "pick-draft-2", "abort"],
      choices: [
        { participantLabel: "Architect", summary: "legacy one" },
        { classification: "unavailable" },
      ],
    });

    expect(decoded?.drafts).toEqual([
      {
        decision: "pick-draft-1",
        slot: 1,
        excerpt: "legacy one",
        label: "Architect",
      },
      { decision: "pick-draft-2", slot: 2, classification: "unavailable" },
    ]);
    expect(decoded?.round).toBe(2);
  });

  it("decides pickability from the stored classification, for new and legacy slots", () => {
    const decoded = decodeConsensusResolutionSchema({
      kind: "consensus_resolution",
      allowedDecisions: ["pick-draft-1", "pick-draft-2", "pick-draft-3"],
      drafts: [
        { decision: "pick-draft-1", classification: "partial" },
        { classification: "unavailable" },
        {},
      ],
    });

    if (!decoded) throw new Error("expected a decoded schema");
    const pickable = ["pick-draft-1", "pick-draft-2", "pick-draft-3"].map(
      (decision) => {
        const draft = consensusDraftForDecision(decoded, decision);

        return draft ? isConsensusDraftPickable(draft) : null;
      },
    );

    expect(pickable).toEqual([true, false, true]);
  });

  it("drops malformed optional fields instead of inventing them", () => {
    const decoded = decodeConsensusResolutionSchema({
      kind: "consensus_resolution",
      allowedDecisions: ["abort"],
      escalationReason: "because",
      drafts: [{ classification: "maybe", excerptBounds: { bytes: "1" } }],
      technicalFailures: [
        {
          verifierId: "qa",
          targetParticipantId: "arch",
          parseStatus: "invalid_json",
          targetSlot: 0,
        },
        { verifierId: "qa" },
      ],
    });

    expect(decoded?.escalationReason).toBeUndefined();
    expect(decoded?.drafts[0]).toEqual({ decision: "pick-draft-1", slot: 1 });
    expect(decoded?.technicalFailures).toEqual([
      {
        verifierId: "qa",
        targetParticipantId: "arch",
        parseStatus: "invalid_json",
        errorCode: "invalid_json",
      },
    ]);
  });
});

describe("consensusPartialCause", () => {
  it.each([
    [
      { reason: "output_cap_exceeded", stopReason: "end_turn" },
      "output_cap_exceeded",
    ],
    [
      { reason: "consensus_draft_incomplete", stopReason: "max_tokens" },
      "max_tokens",
    ],
    [
      { reason: "consensus_draft_incomplete", stopReason: "host_failure" },
      "host_failure",
    ],
    [{ stopReason: "stop_reason_unavailable" }, "unknown"],
    [{}, "unknown"],
  ])("maps %j to %s", (draft, cause) => {
    expect(consensusPartialCause(draft)).toBe(cause);
  });
});
