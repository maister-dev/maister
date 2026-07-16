// Client-safe (pure): the closed objective-check provider adapters (ADR-140
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
    default: {
      const exhaustive: never = spec.provider;

      throw new Error(
        `unknown objective check provider: ${String(exhaustive)}`,
      );
    }
  }
}

export type { OBJECTIVE_CHECK_PROVIDERS };
