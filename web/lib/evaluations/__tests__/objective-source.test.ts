import { describe, expect, it } from "vitest";

import {
  mapGateVerdicts,
  resolveArtifactCompleteness,
} from "@/lib/evaluations/objective/source";

describe("mapGateVerdicts", () => {
  it("keeps only settled passed/failed verdicts", () => {
    const result = mapGateVerdicts([
      { gateId: "lint", status: "passed" },
      { gateId: "test", status: "failed" },
      { gateId: "review", status: "pending" },
      { gateId: "build", status: "running" },
      { gateId: "old", status: "stale" },
      { gateId: "waived", status: "skipped" },
      { gateId: "manual", status: "overridden" },
    ]);

    expect(result).toEqual([
      { gateId: "lint", status: "passed" },
      { gateId: "test", status: "failed" },
    ]);
  });

  it("returns [] when a run has no settled gate verdicts (never a fabricated pass)", () => {
    expect(mapGateVerdicts([{ gateId: "x", status: "pending" }])).toEqual([]);
    expect(mapGateVerdicts([])).toEqual([]);
  });
});

describe("resolveArtifactCompleteness", () => {
  it("reports the missing required artifacts and completeness", () => {
    const result = resolveArtifactCompleteness(
      ["diff", "test_report", null],
      ["diff", "test_report", "lint_report"],
    );

    expect(result.requiredPresent).toBe(false);
    expect(result.missing).toEqual(["lint_report"]);
  });

  it("is complete when every required artifact is present", () => {
    const result = resolveArtifactCompleteness(
      ["diff", "test_report"],
      ["diff", "test_report"],
    );

    expect(result.requiredPresent).toBe(true);
    expect(result.missing).toEqual([]);
  });

  it("ignores null def ids (projector-derived rows) when matching", () => {
    const result = resolveArtifactCompleteness([null, null], ["diff"]);

    expect(result.requiredPresent).toBe(false);
    expect(result.missing).toEqual(["diff"]);
  });
});
