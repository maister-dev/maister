import type { DecideDef } from "@/lib/config.schema";

import { describe, expect, it } from "vitest";

import { computeDecideOutcome } from "@/lib/flows/graph/decide-eval";

describe("computeDecideOutcome — no decide (back-compat)", () => {
  it("returns the legacy outcome unchanged", () => {
    expect(
      computeDecideOutcome({ decide: undefined, vars: {}, legacy: "success" }),
    ).toBe("success");
    expect(
      computeDecideOutcome({ decide: undefined, vars: {}, legacy: "approve" }),
    ).toBe("approve");
  });
});

describe("computeDecideOutcome — from: output.<path>", () => {
  const decide = (from: string): DecideDef => ({ from }) as DecideDef;

  it("routes on a top-level output value", () => {
    expect(
      computeDecideOutcome({
        decide: decide("output.outcome"),
        vars: { outcome: "bug" },
        legacy: "success",
      }),
    ).toBe("bug");
  });

  it("routes on a nested output value", () => {
    expect(
      computeDecideOutcome({
        decide: decide("output.triage.outcome"),
        vars: { triage: { outcome: "feature" } },
        legacy: "success",
      }),
    ).toBe("feature");
  });

  it("coerces a non-string value to string", () => {
    expect(
      computeDecideOutcome({
        decide: decide("output.n"),
        vars: { n: 3 },
        legacy: "success",
      }),
    ).toBe("3");
    expect(
      computeDecideOutcome({
        decide: decide("output.ok"),
        vars: { ok: true },
        legacy: "success",
      }),
    ).toBe("true");
  });

  it("returns undefined for a missing or null value (graceful terminal)", () => {
    expect(
      computeDecideOutcome({
        decide: decide("output.outcome"),
        vars: {},
        legacy: "success",
      }),
    ).toBeUndefined();
    expect(
      computeDecideOutcome({
        decide: decide("output.a.b"),
        vars: { a: 1 },
        legacy: "success",
      }),
    ).toBeUndefined();
    expect(
      computeDecideOutcome({
        decide: decide("output.outcome"),
        vars: { outcome: null },
        legacy: "success",
      }),
    ).toBeUndefined();
  });
});

describe("computeDecideOutcome — from: verdict", () => {
  const decide: DecideDef = {
    from: "verdict",
    cases: [
      { when: "confidence >= 0.8", target: "approve" },
      { when: "confidence < 0.4", target: "rework" },
      { default: true, target: "human" },
    ],
  } as DecideDef;

  it("picks the first matching when-case", () => {
    expect(
      computeDecideOutcome({
        decide,
        vars: {},
        verdict: { verdict: "pass", confidence: 0.9 },
        legacy: "success",
      }),
    ).toBe("approve");
    expect(
      computeDecideOutcome({
        decide,
        vars: {},
        verdict: { verdict: "fail", confidence: 0.2 },
        legacy: "success",
      }),
    ).toBe("rework");
  });

  it("falls through to the default when no when-case matches", () => {
    expect(
      computeDecideOutcome({
        decide,
        vars: {},
        verdict: { verdict: "pass", confidence: 0.6 },
        legacy: "success",
      }),
    ).toBe("human");
  });

  it("a missing confidence field is a no-match → default (never throws)", () => {
    expect(
      computeDecideOutcome({
        decide,
        vars: {},
        verdict: { verdict: "pass" },
        legacy: "success",
      }),
    ).toBe("human");
    expect(
      computeDecideOutcome({ decide, vars: {}, verdict: undefined, legacy: "success" }),
    ).toBe("human");
  });

  it("resolves a nested when field via getPath", () => {
    const nested: DecideDef = {
      from: "verdict",
      cases: [
        { when: "calibration.score >= 0.5", target: "approve" },
        { default: true, target: "review" },
      ],
    } as DecideDef;

    expect(
      computeDecideOutcome({
        decide: nested,
        vars: {},
        verdict: { verdict: "pass", calibration: { score: 0.7 } },
        legacy: "success",
      }),
    ).toBe("approve");
  });
});
