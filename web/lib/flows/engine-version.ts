import "server-only";

import pino from "pino";

import { compareSemver, parseSemver, semverGte } from "./semver";

// Single semver implementation — callers must not hand-roll their own
// comparison. Re-exported so the existing `@/lib/flows/engine-version` import
// site stays the server-side entry point.
export { semverGte };

const log = pino({
  name: "flow-engine-version",
  level: process.env.LOG_LEVEL ?? "info",
});

// The MAIster Flow engine/API version. A Flow package declares an optional
// `compat.engine_min`/`compat.engine_max` range; enablement is refused when the
// running engine falls outside it (see ADR-021). Bump when the Flow runtime
// contract changes in a way packages can depend on.
// Bumped 1.0.0 -> 1.1.0 for Flow graph v1 (`nodes[]`); graph flows MUST declare
// `compat.engine_min >= 1.1.0` (ADR-026).
// Bumped 1.1.0 -> 1.2.0 for typed artifact produces/requires validation (M12).
// Bumped 1.2.0 -> 1.3.0 for structured node output (`output.result`) validation (M26).
// Bumped 1.3.0 -> 1.4.0 for node `retry_policy` + rework `session_policy`/`defaults`
// (M30, ADR-080/081); flows declaring those keys MUST `compat.engine_min >= 1.4.0`.
// Bumped 1.4.0 -> 1.5.0 for the catalog-agent node binding (`settings.agent`)
// (M34, ADR-089); flows declaring it MUST `compat.engine_min >= 1.5.0`.
// Bumped 1.5.0 -> 1.6.0 for the `orchestrator` node type (M37, ADR-098); flows
// declaring an orchestrator node MUST `compat.engine_min >= 1.6.0`.
// Bumped 1.6.0 -> 1.7.0 for output/verdict-driven dynamic routing (node `decide`)
// + malformed-output rework (`output.result.on_mismatch`) (M38, ADR-103); flows
// declaring either MUST `compat.engine_min >= 1.7.0`.
// Bumped 1.7.0 -> 1.8.0 for the guardrail hooks capability class (node
// `settings.hooks`) (M40, ADR-108); flows declaring it MUST
// `compat.engine_min >= 1.8.0` (HOOKS_ENGINE_MIN).
// Bumped 1.8.0 -> 1.9.0 for the first-class `consensus` node type (M41,
// ADR-109); flows declaring it MUST `compat.engine_min >= 1.9.0`.
// Bumped 1.9.0 -> 2.0.0 for the unified runner config + first-class sessions
// (`sessions:`, node `session:`, `settings.runner` unified config + `effort`/
// `env`, judge `runner:`) (M42, ADR-114) — the first stable clean-cutover
// baseline. A manifest declaring any of those MUST `compat.engine_min >= 2.0.0`
// (SESSIONS_ENGINE_MIN, see config.ts).
// Bumped 2.0.0 -> 2.1.0 for rework loop `onExhaustion` routing + human-driven
// counter reset (`resetTargets`) (ADR-118); a manifest where any node's `rework`
// declares either field MUST `compat.engine_min >= 2.1.0` (REWORK_RESET_ENGINE_MIN,
// see config.ts).
// Bumped 2.1.0 -> 2.2.0 for artifact body injection into prompts (ADR-120):
// `input.requires[].inline: true` AND any `{{ artifacts.<id>.content }}` template
// reference both require `compat.engine_min >= 2.2.0` (ARTIFACT_INLINE_ENGINE_MIN,
// see config.ts) — the latter detected by a load-time template scan sharing the
// runtime `collectContentArtifactIds` regex.
// Bumped 2.2.0 -> 3.0.0 for the graph-only cut-over (ADR-131): `steps[]`
// manifests are refused and `nodes[]` is the only executable Flow shape.
// Bumped 3.0.0 -> 3.1.0 for strict typed Plan-review artifacts and the
// declarative `settings.plan_review` graph capability (ADR-137).
// Bumped 3.1.0 -> 3.2.0 for package-sourced Evaluation Methods (M46,
// ADR-143): `maister-package.yaml` may declare `evaluationMethods[]` and a
// method's `evaluation-method.yaml` declares `compat.engine_min/engine_max`.
// A package declaring `evaluationMethods` MUST `compat`-target an engine that
// knows the entity; an engine below a method's `engine_min` refuses enablement
// loudly (EVAL_METHOD_ENGINE_MIN, see lib/evaluations/method.ts).
// Bumped 3.2.0 -> 3.3.0 for MAISTER_FLOW_DIR in the cli/check node-action
// child env (ADR-154): packaged script files become executable from node
// commands. A flow relying on the var MUST `compat.engine_min >= 3.3.0`
// (older engines leave it unset — the documented `:?` command guard turns
// that into an actionable failure).
// Bumped 3.3.0 -> 3.4.0 for `settings.context_repos` on ai_coding/judge/
// orchestrator nodes (ADR-157): read-only sibling-repo checkouts materialized
// under the run dir and exposed to the ACP session. A flow declaring the
// setting MUST `compat.engine_min >= 3.4.0`; the floor is enforced at manifest
// load, so an older engine refuses loudly instead of silently ignoring it.
// Bumped 3.4.0 -> 3.5.0 for the flow-level `reentry` key (ADR-160): the node an
// operator's rework claim re-enters the graph at. A manifest declaring it MUST
// `compat.engine_min >= 3.5.0` (REENTRY_ENGINE_MIN, see config.ts).
// Bumped 3.5.0 -> 3.6.0 for the universal structured-result contract (ADR-162):
// `output.result` on `orchestrator`/`consensus` nodes, and a referenced form-
// schema document using the `json` field type or typed array `items`, MUST
// `compat.engine_min >= 3.6.0` (OUTPUT_COORDINATOR_ENGINE_MIN, see
// config.schema.ts). Below that floor an older engine would pick a transport
// neither coordinator provisions, so the refusal is loud at manifest load and
// at package install.
export const MAISTER_ENGINE_VERSION = "3.6.0";

// Minimum engine version a graph (`nodes[]`) manifest must declare in
// `compat.engine_min` (ADR-026). Enforced in `loadFlowManifest`.
export const GRAPH_MIN_ENGINE_VERSION = "1.1.0";

// Flow manifest `schemaVersion` values this engine can execute. Enablement of a
// revision whose schemaVersion is not listed here is refused.
export const SUPPORTED_FLOW_SCHEMA_VERSIONS: readonly number[] = [1];

export type EngineCompatResult = {
  compatible: boolean;
  // Set when incompatible OR when a bound was unparseable; null on success.
  reason: string | null;
};

// Returns whether MAISTER_ENGINE_VERSION satisfies the [min, max] inclusive
// range. Undefined bounds are open-ended. Unparseable bounds are treated as
// incompatible (a malformed declared range must not silently pass).
export function isEngineCompatible(
  min?: string,
  max?: string,
): EngineCompatResult {
  const engine = parseSemver(MAISTER_ENGINE_VERSION);

  if (!engine) {
    return {
      compatible: false,
      reason: `engine version ${MAISTER_ENGINE_VERSION} is not valid semver`,
    };
  }

  if (min !== undefined) {
    const minTuple = parseSemver(min);

    if (!minTuple) {
      return {
        compatible: false,
        reason: `engine_min "${min}" is not valid semver`,
      };
    }
    if (compareSemver(engine, minTuple) < 0) {
      return {
        compatible: false,
        reason: `engine ${MAISTER_ENGINE_VERSION} < engine_min ${min}`,
      };
    }
  }

  if (max !== undefined) {
    const maxTuple = parseSemver(max);

    if (!maxTuple) {
      return {
        compatible: false,
        reason: `engine_max "${max}" is not valid semver`,
      };
    }
    if (compareSemver(engine, maxTuple) > 0) {
      return {
        compatible: false,
        reason: `engine ${MAISTER_ENGINE_VERSION} > engine_max ${max}`,
      };
    }
  }

  return { compatible: true, reason: null };
}

// Returns whether a Flow manifest schemaVersion is executable by this engine.
export function isSchemaVersionSupported(schemaVersion: number): boolean {
  return SUPPORTED_FLOW_SCHEMA_VERSIONS.includes(schemaVersion);
}

// Returns whether a graph manifest's declared `compat.engine_min` meets the
// graph floor (>= GRAPH_MIN_ENGINE_VERSION). Undefined or unparseable -> false
// (a graph flow must declare a valid, sufficient engine_min — ADR-026).
export function declaresGraphCapableEngineMin(
  engineMin: string | undefined,
): boolean {
  if (engineMin === undefined) return false;

  const declared = parseSemver(engineMin);
  const floor = parseSemver(GRAPH_MIN_ENGINE_VERSION);

  if (!declared || !floor) return false;

  return compareSemver(declared, floor) >= 0;
}

log.info(
  {
    engineVersion: MAISTER_ENGINE_VERSION,
    supportedFlowSchemaVersions: SUPPORTED_FLOW_SCHEMA_VERSIONS,
  },
  "flow engine version resolved",
);
