import "server-only";

import pino from "pino";

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
// (M33, ADR-087); flows declaring it MUST `compat.engine_min >= 1.5.0`.
export const MAISTER_ENGINE_VERSION = "1.5.0";

// Minimum engine version a graph (`nodes[]`) manifest must declare in
// `compat.engine_min` (ADR-026). Enforced in `loadFlowManifest`.
export const GRAPH_MIN_ENGINE_VERSION = "1.1.0";

// Flow manifest `schemaVersion` values this engine can execute. Enablement of a
// revision whose schemaVersion is not listed here is refused.
export const SUPPORTED_FLOW_SCHEMA_VERSIONS: readonly number[] = [1];

type SemverTuple = [number, number, number];

function parseSemver(value: string): SemverTuple | null {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(value.trim());

  if (!m) return null;

  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function compareSemver(a: SemverTuple, b: SemverTuple): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }

  return 0;
}

// Returns true when `value` is a valid X.Y.Z semver >= reference `ref`.
// Returns false for any unparseable input. Single semver implementation —
// callers must not hand-roll their own comparison.
export function semverGte(value: string, ref: string): boolean {
  const v = parseSemver(value);
  const r = parseSemver(ref);

  if (!v || !r) return false;

  return compareSemver(v, r) >= 0;
}

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
