import type { GateVerdict } from "@/lib/db/schema";
import type { DiffChangeStatEntry } from "@/lib/worktree";
import type { EnabledCompletionSettings } from "./completion-policy";

import picomatch from "picomatch";

import { GIT_OBJECT_ID } from "../../../runtime/wait-head";

import { changesDependencyManifest, isHardDeniedChange } from "./classify";
import { completionRisk } from "./completion-policy";

import { isPassVerdict } from "@/lib/flows/graph/gate-verdict";

type Anchor = Readonly<{
  head: string;
  base: string;
  revision: string;
  generation: string;
}>;
type GateReference = Readonly<{ node: string; gate: string }>;
type Gate = Anchor &
  GateReference &
  Readonly<{ attemptId: string; status: string; mode: string }>;
type Ci = Anchor &
  Readonly<{
    node: string;
    attemptId: string;
    checks: readonly string[];
    issuer: string;
    outcome: string;
    source: string;
    current: boolean;
    sourceVerified: boolean;
  }>;
type Diff = Anchor &
  Readonly<{
    clean: boolean;
    complete: boolean;
    dependenciesVerified: boolean;
    files: readonly DiffChangeStatEntry[];
  }>;
export type MergedPullRequestEvidence = Readonly<{
  url: string;
  number: number;
  mergeCommit: string;
  observationId: string;
}>;

export type CompletionEvidence = Readonly<{
  anchor: Anchor;
  launchLimits: EnabledCompletionSettings;
  currentLimits: EnabledCompletionSettings;
  required: Readonly<{
    gates: readonly GateReference[];
    review: GateReference;
    ci: string;
    checks: readonly string[];
  }>;
  gates: readonly Gate[];
  review: (Gate & { readonly verdict: GateVerdict | null }) | null;
  ci: Ci | null;
  diff: Diff | null;
  mergedPr?: MergedPullRequestEvidence;
}>;

export type CompletionEvidenceReason =
  | "candidate_invalid"
  | "required_gate"
  | "review_verdict"
  | "review_threshold"
  | "ci_witness"
  | "diff_unavailable"
  | "deny_list"
  | "diff_bound"
  | "dependency_evidence";
export type CompletionEvidenceDecision =
  { eligible: true } | { eligible: false; reason: CompletionEvidenceReason };

const riskOrder = { low: 0, medium: 1, high: 2 } as const;
const ciConfiguration = picomatch(
  [
    ".gitlab-ci.yml",
    ".gitlab/**",
    ".gitea/workflows/**",
    ".forgejo/workflows/**",
  ],
  { dot: true },
);

function refuses(reason: CompletionEvidenceReason): CompletionEvidenceDecision {
  return { eligible: false, reason };
}

function sameAnchor(expected: Anchor, observed: Anchor): boolean {
  return (
    expected.head === observed.head &&
    expected.base === observed.base &&
    expected.revision === observed.revision &&
    expected.generation === observed.generation
  );
}

function approvedGate(ref: GateReference, gate: Gate, anchor: Anchor): boolean {
  return (
    gate.node === ref.node &&
    gate.gate === ref.gate &&
    gate.attemptId.length > 0 &&
    gate.mode === "blocking" &&
    gate.status === "passed" &&
    sameAnchor(anchor, gate)
  );
}

function exactChecks(
  expected: readonly string[],
  observed: readonly string[],
): boolean {
  return (
    expected.length > 0 &&
    expected.length === observed.length &&
    new Set(observed).size === expected.length &&
    expected.every((name) => observed.includes(name))
  );
}

export function evaluateCompletionEvidence(
  evidence: CompletionEvidence,
): CompletionEvidenceDecision {
  const {
    anchor,
    launchLimits,
    currentLimits,
    required,
    gates,
    review,
    ci,
    diff,
  } = evidence;

  if (
    !GIT_OBJECT_ID.test(anchor.head) ||
    !GIT_OBJECT_ID.test(anchor.base) ||
    !anchor.revision ||
    !anchor.generation
  )
    return refuses("candidate_invalid");
  if (
    !required.gates.length ||
    required.gates.some((ref) => {
      const matching = gates.filter(
        (gate) => gate.node === ref.node && gate.gate === ref.gate,
      );

      return matching.length !== 1 || !approvedGate(ref, matching[0], anchor);
    })
  )
    return refuses("required_gate");

  const risk = completionRisk.safeParse(review?.verdict?.risk);
  const confidence = review?.verdict?.confidence;

  if (
    !review ||
    !approvedGate(required.review, review, anchor) ||
    !review.verdict?.verdict ||
    !isPassVerdict(review.verdict.verdict) ||
    !risk.success ||
    typeof confidence !== "number" ||
    !Number.isFinite(confidence) ||
    confidence < 0 ||
    confidence > 1
  )
    return refuses("review_verdict");
  if (
    riskOrder[risk.data] >
      Math.min(
        riskOrder[launchLimits.riskMax],
        riskOrder[currentLimits.riskMax],
      ) ||
    confidence <
      Math.max(launchLimits.confidenceMin, currentLimits.confidenceMin)
  )
    return refuses("review_threshold");

  if (
    !ci ||
    ci.node !== required.ci ||
    !ci.attemptId ||
    !ci.current ||
    !ci.sourceVerified ||
    ci.outcome !== "success" ||
    (ci.source !== "provider" && ci.source !== "signal") ||
    !sameAnchor(anchor, ci) ||
    !exactChecks(required.checks, ci.checks) ||
    !launchLimits.approvedCiSources.includes(ci.issuer) ||
    !currentLimits.approvedCiSources.includes(ci.issuer)
  )
    return refuses("ci_witness");

  if (
    !diff ||
    !diff.clean ||
    !diff.complete ||
    !sameAnchor(anchor, diff) ||
    !diff.files.length ||
    diff.files.some(
      (file) =>
        file.binary ||
        !file.path ||
        !Number.isSafeInteger(file.additions) ||
        !Number.isSafeInteger(file.deletions) ||
        file.additions < 0 ||
        file.deletions < 0,
    )
  )
    return refuses("diff_unavailable");
  if (
    diff.files.some(
      (file) =>
        isHardDeniedChange(file) ||
        ciConfiguration(file.path) ||
        (file.oldPath !== undefined && ciConfiguration(file.oldPath)),
    )
  )
    return refuses("deny_list");
  if (!diff.dependenciesVerified && diff.files.some(changesDependencyManifest))
    return refuses("dependency_evidence");

  const paths = new Set(
    diff.files.flatMap(({ path, oldPath }) =>
      oldPath ? [path, oldPath] : [path],
    ),
  );
  const lines = diff.files.reduce(
    (total, file) => total + file.additions + file.deletions,
    0,
  );

  if (
    paths.size >
      Math.min(launchLimits.changedFilesMax, currentLimits.changedFilesMax) ||
    lines >
      Math.min(launchLimits.changedLinesMax, currentLimits.changedLinesMax)
  )
    return refuses("diff_bound");

  return { eligible: true };
}
