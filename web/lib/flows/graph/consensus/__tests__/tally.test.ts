import type { ParsedConsensusVerdict } from "../verdict";

import { describe, expect, it } from "vitest";

import { tallyConsensus } from "../tally";

const AXES = ["scope", "migration"] as const;

function verdict(
  overrides: Partial<ParsedConsensusVerdict> = {},
): ParsedConsensusVerdict {
  return {
    parseStatus: "parsed",
    verdict: "agree",
    axes: { scope: true, migration: true },
    disagreements: [],
    ...overrides,
  };
}

describe("tallyConsensus", () => {
  it("reaches consensus only when every verifier agrees and every axis is true", () => {
    const result = tallyConsensus({
      materialAxes: AXES,
      verdicts: [verdict(), verdict({ confidence: 0.1 })],
    });

    expect(result).toEqual({
      agreementReached: true,
      disagreementCount: 0,
      failedAxes: [],
      disagreements: [],
      invalidVerdictCount: 0,
    });
  });

  it("does not reach consensus when any verifier disagrees", () => {
    const result = tallyConsensus({
      materialAxes: AXES,
      verdicts: [
        verdict(),
        verdict({
          verdict: "disagree",
          disagreements: [
            {
              axis: "scope",
              claim: "Scope includes writable drafts.",
              counterEvidence: "M41 is read-only.",
            },
          ],
        }),
      ],
    });

    expect(result.agreementReached).toBe(false);
    expect(result.disagreementCount).toBe(1);
    expect(result.disagreements).toHaveLength(1);
  });

  it("does not reach consensus when any material axis is false", () => {
    const result = tallyConsensus({
      materialAxes: AXES,
      verdicts: [verdict({ axes: { scope: true, migration: false } })],
    });

    expect(result.agreementReached).toBe(false);
    expect(result.failedAxes).toEqual(["migration"]);
  });

  it("treats malformed parsed results as failed-closed disagreement evidence", () => {
    const result = tallyConsensus({
      materialAxes: AXES,
      verdicts: [
        verdict({
          parseStatus: "invalid_json",
          verdict: "disagree",
          axes: { scope: false, migration: false },
        }),
      ],
    });

    expect(result.agreementReached).toBe(false);
    expect(result.disagreementCount).toBe(1);
    expect(result.invalidVerdictCount).toBe(1);
    expect(result.failedAxes).toEqual(["scope", "migration"]);
  });

  it("ignores confidence for the consensus decision", () => {
    const lowConfidence = tallyConsensus({
      materialAxes: AXES,
      verdicts: [verdict({ confidence: 0 })],
    });

    expect(lowConfidence.agreementReached).toBe(true);
  });
});
