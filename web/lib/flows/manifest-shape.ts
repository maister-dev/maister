export const LEGACY_STEPS_REFUSAL_MESSAGE =
  "legacy steps[] flows are not supported since engine 3.0.0; republish the package with nodes[]";

export type FlowManifestShape =
  | "graph"
  | "legacy_steps"
  | "mixed"
  | "missing"
  | "invalid";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function classifyFlowManifestShape(value: unknown): FlowManifestShape {
  if (!isRecord(value)) return "invalid";

  const hasNodes = Object.prototype.hasOwnProperty.call(value, "nodes");
  const hasSteps = Object.prototype.hasOwnProperty.call(value, "steps");

  if (hasNodes && hasSteps) return "mixed";
  if (hasSteps) return "legacy_steps";
  if (hasNodes) return "graph";

  return "missing";
}
