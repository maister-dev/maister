// Client-safe (pure): the closed objective-check provider adapters (ADR-143
// D11). Providers are NON-EXECUTABLE from package content — each reads a
// recorded/derived fact from an injected fact source; NONE runs a
// package-supplied command. Build/test/lint runs only through a pre-registered
// host profile whose command+sandbox are platform-owned (never here).

import type {
  ObjectiveCheckProvider,
  OBJECTIVE_CHECK_PROVIDERS,
} from "@/lib/evaluations/method-schema";
import type { EvaluationObjectiveCheckStatus } from "@/lib/evaluations/types";

// The recorded facts a provider may read. Populated by the execution layer from
// real readers (gate_results, artifact_instances, evidence manifest, registered
// host profiles). A missing fact is honest absence — never inferred PASS.
export interface ObjectiveFactSource {
  // Recorded gate outcomes for the participant's Run (already-executed facts).
  gateResults?: Array<{ gateId: string; status: "passed" | "failed" }>;
  // Produced-artifact completeness against the required set.
  artifactCompleteness?: { requiredPresent: boolean; missing: string[] } | null;
  // Recorded schema/contract validation outcome.
  schemaContract?: { valid: boolean; errors: string[] } | null;
  // Source/diff manifest statistics (a metric, never a pass/fail).
  diffStats?: { files: number; additions: number; deletions: number } | null;
  // Operator-registered trusted host check profiles (platform-owned). A named
  // profile absent here → the check is `unavailable`, never PASS.
  registeredHostProfiles?: Set<string>;
  // ADR-165: the participant's RUN TREE, as recorded facts. Absent for a
  // participant that is not a tree root — the harness measures are then
  // `unavailable`, which is what makes a flat arm and a harness arm comparable
  // without inventing zeroes for the flat one.
  tree?: ObjectiveTreeFacts;
}

/**
 * Tree-scoped facts for the ADR-165 measures. Every field is a RECORDED value
 * read by the execution layer — ids rather than counts where a measure is an
 * INTERSECTION, because "did the parent use the results?" cannot be answered
 * from two totals.
 */
export interface ObjectiveTreeFacts {
  /** Descendants at any depth (recursive over `parent_run_id`). */
  childRunCount: number;
  /** `run_results` rows with `validity='invalid'` over the tree. */
  invalidResultCount: number;
  /** Children holding a `valid` result row — the denominator of both ratios. */
  validResultChildRunIds: string[];
  /** Of those, the ones the engine actually SERVED (`first_collected_at`). */
  collectedChildRunIds: string[];
  /** The root result's SELF-REPORTED `consumedChildRunIds`, verbatim. */
  consumedChildRunIds: string[];
  reworkCount: number;
  crashCount: number;
  treeTokens: number;
  treeWallClockMinutes: number;
  /** The readiness classifier's recorded state, or null when none. */
  promotionReadiness: string | null;
}

export interface ObjectiveCheckSpec {
  id: string;
  provider: ObjectiveCheckProvider;
  policy: string;
  criterionId?: string;
  hostCheckProfile?: string;
}

export interface ObjectiveCheckOutcome {
  status: EvaluationObjectiveCheckStatus;
  // Every nonterminal/absence status carries a reason (D11). PASS never carries
  // a "looks fine" rationale — it only follows an executed/recorded fact.
  reason?: string;
  // For metric-policy providers: a normalized measured value + unit.
  metric?: { value: Record<string, unknown>; unit?: string } | null;
}

// The provider version is embedded in the id (`gate_result@1`); split for
// storage as check_id + check_version.
export function splitProviderVersion(provider: ObjectiveCheckProvider): {
  checkId: string;
  version: string;
} {
  const at = provider.lastIndexOf("@");

  return {
    checkId: provider.slice(0, at),
    version: provider.slice(at + 1),
  };
}

function gateResult(facts: ObjectiveFactSource): ObjectiveCheckOutcome {
  const gates = facts.gateResults;

  if (gates === undefined) {
    return { status: "not_run", reason: "no recorded gate results captured" };
  }
  if (gates.length === 0) {
    return { status: "not_run", reason: "participant Run declared no gates" };
  }

  const failed = gates.filter((g) => g.status === "failed");

  return failed.length > 0
    ? {
        status: "failed",
        reason: `${failed.length} gate(s) failed: ${failed
          .map((g) => g.gateId)
          .join(", ")}`,
      }
    : { status: "passed" };
}

function artifactCompleteness(
  facts: ObjectiveFactSource,
): ObjectiveCheckOutcome {
  const completeness = facts.artifactCompleteness;

  if (!completeness) {
    return {
      status: "not_run",
      reason: "no recorded artifact completeness fact",
    };
  }

  return completeness.requiredPresent
    ? { status: "passed" }
    : {
        status: "failed",
        reason: `missing required artifacts: ${completeness.missing.join(", ")}`,
      };
}

function schemaContract(facts: ObjectiveFactSource): ObjectiveCheckOutcome {
  const contract = facts.schemaContract;

  if (!contract) {
    return {
      status: "unavailable",
      reason: "no recorded schema/contract validation",
    };
  }

  return contract.valid
    ? { status: "passed" }
    : {
        status: "failed",
        reason: `contract validation failed: ${contract.errors.join("; ")}`,
      };
}

function diffStats(facts: ObjectiveFactSource): ObjectiveCheckOutcome {
  const stats = facts.diffStats;

  if (!stats) {
    return {
      status: "unavailable",
      reason: "no source/diff manifest statistics captured",
    };
  }

  // diff_stats is a METRIC provider: it records a measured fact, not a verdict.
  return {
    status: "passed",
    metric: {
      value: {
        files: stats.files,
        additions: stats.additions,
        deletions: stats.deletions,
      },
      unit: "count",
    },
  };
}

function trustedHostCheck(
  spec: ObjectiveCheckSpec,
  facts: ObjectiveFactSource,
): ObjectiveCheckOutcome {
  const profile = spec.hostCheckProfile;

  if (!profile) {
    return {
      status: "error",
      reason: "trusted_host_check names no host profile",
    };
  }
  // The command/sandbox is platform-owned. Without a registered host profile the
  // check is UNAVAILABLE — never a PASS inferred from source appearance (D11).
  if (!facts.registeredHostProfiles?.has(profile)) {
    return {
      status: "unavailable",
      reason: `host check profile "${profile}" is not registered on this host`,
    };
  }

  // A registered profile whose execution result is not yet captured stays
  // not_run (honest) — the real host-runner result lands with the capture
  // pipeline (T2.3 co-evolve).
  return {
    status: "not_run",
    reason: `host check profile "${profile}" registered; execution result not yet captured`,
  };
}

// --- ADR-165: the recursive-harness measures --------------------------------
//
// All nine are METRIC providers: they record what happened, never a verdict on
// it. "Is 6 children too many?" is a judging question, and answering it here
// would put a threshold nobody agreed to inside a fact.

const NO_TREE = "no recorded run-tree facts for this participant";

/** A measured tree value, or `unavailable` when the tree facts are absent. */
function treeMetric(
  facts: ObjectiveFactSource,
  measure: (tree: ObjectiveTreeFacts) => ObjectiveCheckOutcome,
): ObjectiveCheckOutcome {
  return facts.tree
    ? measure(facts.tree)
    : { status: "unavailable", reason: NO_TREE };
}

function counted(
  value: number,
  key: string,
  unit: string,
): ObjectiveCheckOutcome {
  return { status: "passed", metric: { value: { [key]: value }, unit } };
}

/**
 * `hits ÷ validResultChildRunIds`, as a measured ratio.
 *
 * A denominator of zero is `unavailable`, NOT 0: no valid results means the
 * ratio is undefined, and recording it as 0 would rank a tree that produced
 * nothing to collect below one that collected everything it had.
 */
function resultRatio(
  tree: ObjectiveTreeFacts,
  hitIds: string[],
  key: "collected" | "consumed",
): ObjectiveCheckOutcome {
  const valid = new Set(tree.validResultChildRunIds);

  if (valid.size === 0) {
    return {
      status: "unavailable",
      reason:
        "no child holds a valid result — the ratio is undefined, not zero",
    };
  }

  // The INTERSECTION is the point (ADR-165): an id the parent names but that
  // holds no valid row — a fabricated one — contributes nothing, and a
  // duplicate contributes once.
  const hits = new Set(hitIds.filter((id) => valid.has(id)));

  return {
    status: "passed",
    metric: {
      value: {
        [key]: hits.size,
        valid: valid.size,
        ratio: hits.size / valid.size,
      },
      unit: "ratio",
    },
  };
}

// Evaluate one closed provider against the recorded facts. An unknown provider
// is a typed CONFIG-shaped guard (the method schema already closes the set, but
// the runtime dispatch stays exhaustive so a new enum value can never silently
// no-op).
export function evaluateObjectiveCheck(
  spec: ObjectiveCheckSpec,
  facts: ObjectiveFactSource,
): ObjectiveCheckOutcome {
  switch (spec.provider) {
    case "gate_result@1":
      return gateResult(facts);
    case "artifact_completeness@1":
      return artifactCompleteness(facts);
    case "schema_contract@1":
      return schemaContract(facts);
    case "diff_stats@1":
      return diffStats(facts);
    case "trusted_host_check@1":
      return trustedHostCheck(spec, facts);
    case "child_run_count@1":
      return treeMetric(facts, (t) =>
        counted(t.childRunCount, "count", "count"),
      );
    case "result_validation_failures@1":
      return treeMetric(facts, (t) =>
        counted(t.invalidResultCount, "count", "count"),
      );
    case "collected_results_ratio@1":
      return treeMetric(facts, (t) =>
        resultRatio(t, t.collectedChildRunIds, "collected"),
      );
    case "consumed_results_ratio@1":
      return treeMetric(facts, (t) =>
        resultRatio(t, t.consumedChildRunIds, "consumed"),
      );
    case "rework_count@1":
      return treeMetric(facts, (t) => counted(t.reworkCount, "count", "count"));
    case "crash_count@1":
      return treeMetric(facts, (t) => counted(t.crashCount, "count", "count"));
    case "tree_tokens@1":
      return treeMetric(facts, (t) =>
        counted(t.treeTokens, "tokens", "tokens"),
      );
    case "tree_wall_clock_minutes@1":
      return treeMetric(facts, (t) =>
        counted(t.treeWallClockMinutes, "minutes", "minutes"),
      );
    case "promotion_readiness@1":
      return treeMetric(facts, (t) =>
        t.promotionReadiness === null
          ? {
              status: "unavailable",
              reason: "no recorded readiness classification",
            }
          : {
              status: "passed",
              metric: { value: { state: t.promotionReadiness }, unit: "state" },
            },
      );
    default: {
      const exhaustive: never = spec.provider;

      throw new Error(
        `unknown objective check provider: ${String(exhaustive)}`,
      );
    }
  }
}

export type { OBJECTIVE_CHECK_PROVIDERS };
