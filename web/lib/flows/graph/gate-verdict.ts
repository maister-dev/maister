import type { GateVerdict } from "@/lib/db/schema";

import { extractBalancedJsonObjects } from "./json-extract";

export type GateOutput = Readonly<{
  depth: number;
  quoted: boolean;
  escaped: boolean;
  candidate: string | null;
  verdict: GateVerdict | null;
  evidence: string;
}>;

export function emptyGateOutput(): GateOutput {
  return {
    depth: 0,
    quoted: false,
    escaped: false,
    candidate: "",
    verdict: null,
    evidence: "",
  };
}

function appendCandidate(
  candidate: string | null,
  part: string,
): string | null {
  return candidate !== null && candidate.length + part.length <= 1_000_000
    ? candidate + part
    : null;
}

/** Parse complete objects across chunks, independently of the stdout preview.
 * A single candidate is bounded to the existing 1 MiB text ceiling. An oversized
 * later object invalidates the earlier verdict; its suffix cannot become a
 * plausible nested replacement. Full bytes remain in the command manifest.
 */
export function appendGateOutput(
  previous: GateOutput,
  chunk: string,
): GateOutput {
  let { depth, quoted, escaped, candidate, verdict } = previous;
  let start = depth > 0 ? 0 : -1;

  for (let index = 0; index < chunk.length; index += 1) {
    const char = chunk[index];

    if (depth === 0) {
      if (char !== "{") continue;
      start = index;
      depth = 1;
      candidate = "";
      continue;
    }
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quoted && char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (quoted) continue;
    if (char === "{") depth += 1;
    if (char === "}") depth -= 1;
    if (depth !== 0) continue;
    candidate = appendCandidate(candidate, chunk.slice(start, index + 1));
    if (candidate === null) verdict = null;
    else verdict = parseVerdict(candidate) ?? verdict;
    candidate = "";
    start = -1;
  }
  if (start >= 0) candidate = appendCandidate(candidate, chunk.slice(start));

  return {
    depth,
    quoted,
    escaped,
    candidate,
    verdict,
    evidence: (previous.evidence + chunk).slice(0, 2000),
  };
}

const PASS_VERDICTS = new Set([
  "pass",
  "passed",
  "approve",
  "approved",
  "ok",
  "success",
  "succeeded",
  "ready",
]);

// Tolerant structured-verdict parser for ai_judgment / skill_check output:
// find the LAST brace-balanced JSON object in the agent's text that carries a
// string `verdict` (handles nested objects). Returns null when none is found
// (caller records a `failed` gate with the raw prose as evidence — never a
// thrown domain code, ADR-028).
export function parseVerdict(output: string): GateVerdict | null {
  const candidates = extractBalancedJsonObjects(output);

  for (let i = candidates.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(candidates[i]) as Record<string, unknown>;

      if (obj && typeof obj === "object" && typeof obj.verdict === "string") {
        return {
          verdict: obj.verdict,
          confidence:
            typeof obj.confidence === "number" ? obj.confidence : undefined,
          reasons: Array.isArray(obj.reasons)
            ? obj.reasons.map((r) => String(r))
            : undefined,
          recommendedAction:
            typeof obj.recommendedAction === "string"
              ? obj.recommendedAction
              : undefined,
        };
      }
    } catch {
      // not valid JSON — keep scanning earlier candidates
    }
  }

  return null;
}

export function isPassVerdict(verdict: string): boolean {
  return PASS_VERDICTS.has(verdict.trim().toLowerCase());
}

// Applies the effective calibration policy to a parsed PASS verdict.
// Only call when isPassVerdict(parsed.verdict) is true.
// Returns { pass: true } with no calibration when no threshold is configured
// (legacy pass). When a threshold is set, returns the deterministic outcome
// and attaches the calibration sub-object so the caller can persist it.
export function calibrateVerdict(
  parsed: GateVerdict,
  calibration:
    | { confidence_min?: number; allow_missing_confidence?: boolean }
    | undefined,
): { pass: boolean; calibration?: GateVerdict["calibration"] } {
  if (calibration?.confidence_min === undefined) {
    // No threshold configured — legacy pass, no calibration recorded.
    return { pass: true };
  }

  const confidenceMin = calibration.confidence_min;
  const rawVerdict = parsed.verdict!;

  if (typeof parsed.confidence === "number") {
    // Agent-emitted confidence MUST lie in the documented 0..1 domain. A
    // malformed value (NaN, ±Infinity, <0, >1) is fail-closed as
    // `invalid_confidence` — it must NEVER clear the threshold (e.g. `2 >= 0.8`)
    // and must NOT be rescued by allow_missing_confidence (it is present, just
    // out of range). config-side confidence_min is already bounded by zod
    // (config.schema.ts z.number().min(0).max(1)); this guards the untrusted side.
    if (
      !Number.isFinite(parsed.confidence) ||
      parsed.confidence < 0 ||
      parsed.confidence > 1
    ) {
      return {
        pass: false,
        calibration: {
          confidenceMin,
          rawVerdict,
          outcome: "invalid_confidence",
        },
      };
    }

    if (parsed.confidence >= confidenceMin) {
      return {
        pass: true,
        calibration: { confidenceMin, rawVerdict, outcome: "above_threshold" },
      };
    }

    return {
      pass: false,
      calibration: { confidenceMin, rawVerdict, outcome: "below_threshold" },
    };
  }

  // Confidence absent.
  if (calibration.allow_missing_confidence === true) {
    return {
      pass: true,
      calibration: {
        confidenceMin,
        rawVerdict,
        outcome: "missing_confidence_allowed",
      },
    };
  }

  return {
    pass: false,
    calibration: { confidenceMin, rawVerdict, outcome: "no_confidence" },
  };
}
