import { describe, expect, it } from "vitest";

import { parseConsensusVerdict } from "../verdict";

const AXES = [
  "scope_matches_milestone",
  "migration_order_is_safe",
  "human_handoff_is_clear",
] as const;

describe("parseConsensusVerdict", () => {
  it("extracts the last valid consensus verdict object from prose", () => {
    const parsed = parseConsensusVerdict(
      [
        "First draft:",
        '{"verdict":"disagree","axes":{"scope_matches_milestone":false,"migration_order_is_safe":true,"human_handoff_is_clear":true}}',
        "Final:",
        '{"verdict":"agree","axes":{"scope_matches_milestone":true,"migration_order_is_safe":true,"human_handoff_is_clear":true},"disagreements":[],"confidence":0.72}',
      ].join("\n"),
      AXES,
    );

    expect(parsed).toEqual({
      parseStatus: "parsed",
      verdict: "agree",
      axes: {
        scope_matches_milestone: true,
        migration_order_is_safe: true,
        human_handoff_is_clear: true,
      },
      disagreements: [],
      confidence: 0.72,
    });
  });

  it("handles nested JSON and braces inside strings", () => {
    const parsed = parseConsensusVerdict(
      '{"verdict":"disagree","axes":{"scope_matches_milestone":true,"migration_order_is_safe":false,"human_handoff_is_clear":true},"disagreements":[{"axis":"migration_order_is_safe","claim":"uses {unsafe} migration","counter_evidence":"0068 is reserved"}],"meta":{"nested":{"ok":true}}}',
      AXES,
    );

    expect(parsed.parseStatus).toBe("parsed");
    expect(parsed.verdict).toBe("disagree");
    expect(parsed.disagreements).toEqual([
      {
        axis: "migration_order_is_safe",
        claim: "uses {unsafe} migration",
        counterEvidence: "0068 is reserved",
      },
    ]);
  });

  it("fails closed when no valid JSON object exists", () => {
    expect(parseConsensusVerdict("plain prose", AXES)).toMatchObject({
      parseStatus: "invalid_json",
      verdict: "disagree",
      axes: {
        scope_matches_milestone: false,
        migration_order_is_safe: false,
        human_handoff_is_clear: false,
      },
      disagreements: [],
    });
  });

  it("fails closed on invalid verdict enum", () => {
    expect(
      parseConsensusVerdict(
        '{"verdict":"maybe","axes":{"scope_matches_milestone":true,"migration_order_is_safe":true,"human_handoff_is_clear":true}}',
        AXES,
      ),
    ).toMatchObject({
      parseStatus: "invalid_schema",
      verdict: "disagree",
    });
  });

  it("fails closed when a declared material axis is missing", () => {
    expect(
      parseConsensusVerdict(
        '{"verdict":"agree","axes":{"scope_matches_milestone":true,"migration_order_is_safe":true}}',
        AXES,
      ),
    ).toMatchObject({
      parseStatus: "missing_axes",
      verdict: "disagree",
    });
  });

  it("fails closed when the verifier reports an unknown axis", () => {
    expect(
      parseConsensusVerdict(
        '{"verdict":"agree","axes":{"scope_matches_milestone":true,"migration_order_is_safe":true,"human_handoff_is_clear":true,"extra_axis":true}}',
        AXES,
      ),
    ).toMatchObject({
      parseStatus: "unknown_axes",
      verdict: "disagree",
    });
  });

  it("fails closed on malformed disagreement shape", () => {
    expect(
      parseConsensusVerdict(
        '{"verdict":"disagree","axes":{"scope_matches_milestone":true,"migration_order_is_safe":true,"human_handoff_is_clear":true},"disagreements":[{"axis":"scope_matches_milestone","claim":7,"counter_evidence":"x"}]}',
        AXES,
      ),
    ).toMatchObject({
      parseStatus: "invalid_schema",
      verdict: "disagree",
    });
  });
});
