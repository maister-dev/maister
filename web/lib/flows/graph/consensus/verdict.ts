import { extractBalancedJsonObjects } from "../json-extract";

export type ConsensusVerdictValue = "agree" | "disagree";

export type ConsensusParseStatus =
  | "parsed"
  | "invalid_json"
  | "invalid_schema"
  | "missing_axes"
  | "unknown_axes";

export type ConsensusDisagreement = {
  axis: string;
  claim: string;
  counterEvidence: string;
};

export type ParsedConsensusVerdict = {
  parseStatus: ConsensusParseStatus;
  verdict: ConsensusVerdictValue;
  axes: Record<string, boolean>;
  disagreements: ConsensusDisagreement[];
  confidence?: number;
};

function closedAxes(materialAxes: readonly string[]): Record<string, boolean> {
  return Object.fromEntries(materialAxes.map((axis) => [axis, false]));
}

function failClosed(
  parseStatus: Exclude<ConsensusParseStatus, "parsed">,
  materialAxes: readonly string[],
): ParsedConsensusVerdict {
  return {
    parseStatus,
    verdict: "disagree",
    axes: closedAxes(materialAxes),
    disagreements: [],
  };
}

function parseLastJsonObject(output: string): Record<string, unknown> | null {
  const candidates = extractBalancedJsonObjects(output);

  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    try {
      const parsed = JSON.parse(candidates[index]) as unknown;

      if (parsed !== null && typeof parsed === "object") {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Keep scanning earlier brace-balanced candidates.
    }
  }

  return null;
}

function parseAxes(
  rawAxes: unknown,
  materialAxes: readonly string[],
):
  | { status: "ok"; axes: Record<string, boolean> }
  | { status: "missing_axes" | "unknown_axes" | "invalid_schema" } {
  if (
    rawAxes === null ||
    typeof rawAxes !== "object" ||
    Array.isArray(rawAxes)
  ) {
    return { status: "missing_axes" };
  }

  const declared = new Set(materialAxes);
  const axisEntries = Object.entries(rawAxes as Record<string, unknown>);
  const unknownAxis = axisEntries.find(([axis]) => !declared.has(axis));

  if (unknownAxis !== undefined) return { status: "unknown_axes" };

  const axes: Record<string, boolean> = {};

  for (const axis of materialAxes) {
    const value = (rawAxes as Record<string, unknown>)[axis];

    if (value === undefined) return { status: "missing_axes" };
    if (typeof value !== "boolean") return { status: "invalid_schema" };
    axes[axis] = value;
  }

  return { status: "ok", axes };
}

function parseDisagreements(
  rawDisagreements: unknown,
  materialAxes: readonly string[],
):
  | { status: "ok"; disagreements: ConsensusDisagreement[] }
  | { status: "invalid_schema" | "unknown_axes" } {
  if (rawDisagreements === undefined) {
    return { status: "ok", disagreements: [] };
  }
  if (!Array.isArray(rawDisagreements)) {
    return { status: "invalid_schema" };
  }

  const declared = new Set(materialAxes);
  const disagreements: ConsensusDisagreement[] = [];

  for (const item of rawDisagreements) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      return { status: "invalid_schema" };
    }

    const record = item as Record<string, unknown>;
    const axis = record.axis;
    const claim = record.claim;
    const counterEvidence = record.counter_evidence;

    if (typeof axis !== "string" || !declared.has(axis)) {
      return { status: "unknown_axes" };
    }
    if (typeof claim !== "string" || typeof counterEvidence !== "string") {
      return { status: "invalid_schema" };
    }

    disagreements.push({ axis, claim, counterEvidence });
  }

  return { status: "ok", disagreements };
}

export function parseConsensusVerdict(
  output: string,
  materialAxes: readonly string[],
): ParsedConsensusVerdict {
  const obj = parseLastJsonObject(output);

  if (obj === null) return failClosed("invalid_json", materialAxes);
  if (obj.verdict !== "agree" && obj.verdict !== "disagree") {
    return failClosed("invalid_schema", materialAxes);
  }

  const axesResult = parseAxes(obj.axes, materialAxes);

  if (axesResult.status !== "ok") {
    return failClosed(axesResult.status, materialAxes);
  }

  const disagreementsResult = parseDisagreements(
    obj.disagreements,
    materialAxes,
  );

  if (disagreementsResult.status !== "ok") {
    return failClosed(disagreementsResult.status, materialAxes);
  }

  const confidence =
    typeof obj.confidence === "number" && Number.isFinite(obj.confidence)
      ? obj.confidence
      : undefined;

  return {
    parseStatus: "parsed",
    verdict: obj.verdict,
    axes: axesResult.axes,
    disagreements: disagreementsResult.disagreements,
    ...(confidence !== undefined ? { confidence } : {}),
  };
}
