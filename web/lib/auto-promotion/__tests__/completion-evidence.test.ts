import { describe, expect, it } from "vitest";

import {
  evaluateCompletionEvidence,
  type CompletionEvidence,
} from "../completion-evidence";

const head = "1".repeat(40);
const anchor = {
  head,
  base: "2".repeat(40),
  revision: "reviewed-flow",
  generation: "current-publication",
};
const limits = {
  enabled: true,
  riskMax: "low",
  confidenceMin: 0.9,
  changedFilesMax: 2,
  changedLinesMax: 3,
  approvedCiSources: ["gh-actions"],
} as const;
const requiredGate = { node: "verify", gate: "tests" };
const requiredReview = { node: "review", gate: "risk" };
const evidence: CompletionEvidence = {
  anchor,
  launchLimits: { ...limits, approvedCiSources: [...limits.approvedCiSources] },
  currentLimits: {
    ...limits,
    approvedCiSources: [...limits.approvedCiSources],
  },
  gates: [
    {
      ...anchor,
      ...requiredGate,
      attemptId: "verify-2",
      status: "passed",
      mode: "blocking",
    },
  ],
  review: {
    ...anchor,
    ...requiredReview,
    attemptId: "review-3",
    status: "passed",
    mode: "blocking",
    verdict: { verdict: "pass", confidence: 0.9, risk: "low" },
  },
  ci: {
    ...anchor,
    node: "ci",
    attemptId: "wait-4",
    checks: ["unit", "e2e"],
    issuer: "gh-actions",
    outcome: "success",
    source: "provider",
    current: true,
    sourceVerified: true,
  },
  required: {
    gates: [requiredGate],
    review: requiredReview,
    ci: "ci",
    checks: ["e2e", "unit"],
  },
  diff: {
    ...anchor,
    clean: true,
    complete: true,
    dependenciesVerified: true,
    files: [
      {
        path: "src/new.ts",
        oldPath: "src/old.ts",
        status: "R",
        additions: 1,
        deletions: 2,
        binary: false,
      },
    ],
  },
};

describe("C02 exact-head completion evidence", () => {
  it("allows matching witnesses from different producer attempts at the stricter thresholds", () => {
    expect(evaluateCompletionEvidence(evidence)).toEqual({ eligible: true });
  });

  it.each([
    [
      "required_gate",
      { gates: [{ ...evidence.gates[0], status: "overridden" }] },
    ],
    [
      "required_gate",
      { gates: [{ ...evidence.gates[0], base: "3".repeat(40) }] },
    ],
    [
      "review_verdict",
      {
        review: {
          ...evidence.review!,
          verdict: { verdict: "pass", confidence: 0.9 },
        },
      },
    ],
    [
      "review_threshold",
      { currentLimits: { ...evidence.currentLimits, confidenceMin: 0.91 } },
    ],
    ["ci_witness", { ci: { ...evidence.ci!, source: "operator" } }],
    ["ci_witness", { ci: { ...evidence.ci!, current: false } }],
    ["ci_witness", { ci: { ...evidence.ci!, checks: ["unit"] } }],
    ["ci_witness", { ci: { ...evidence.ci!, generation: "superseded" } }],
    [
      "diff_bound",
      { currentLimits: { ...evidence.currentLimits, changedFilesMax: 1 } },
    ],
    [
      "diff_unavailable",
      {
        diff: {
          ...evidence.diff!,
          files: [{ ...evidence.diff!.files[0], binary: true }],
        },
      },
    ],
    [
      "deny_list",
      {
        diff: {
          ...evidence.diff!,
          files: [
            {
              ...evidence.diff!.files[0],
              oldPath: ".github/workflows/build.yaml",
            },
          ],
        },
      },
    ],
  ] satisfies readonly (readonly [string, Partial<CompletionEvidence>])[])(
    "refuses changed evidence with reason %s",
    (reason, changed) => {
      expect(evaluateCompletionEvidence({ ...evidence, ...changed })).toEqual({
        eligible: false,
        reason,
      });
    },
  );
});
