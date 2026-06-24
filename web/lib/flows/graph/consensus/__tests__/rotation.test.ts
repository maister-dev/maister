import { describe, expect, it } from "vitest";

import { buildConsensusRotation } from "../rotation";

describe("buildConsensusRotation", () => {
  it("rotates each participant to audit the next participant by declaration order", () => {
    expect(buildConsensusRotation(["architect", "implementer", "qa"])).toEqual([
      { verifierId: "architect", targetParticipantId: "implementer" },
      { verifierId: "implementer", targetParticipantId: "qa" },
      { verifierId: "qa", targetParticipantId: "architect" },
    ]);
  });

  it("is stable for two participants", () => {
    expect(buildConsensusRotation(["a", "b"])).toEqual([
      { verifierId: "a", targetParticipantId: "b" },
      { verifierId: "b", targetParticipantId: "a" },
    ]);
  });

  it("throws for fewer than two participants", () => {
    expect(() => buildConsensusRotation(["solo"])).toThrow(/at least two/);
  });
});
