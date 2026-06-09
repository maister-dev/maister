import type { FlowYamlV1 } from "@/lib/config.schema";

import { flowPresentationSchema } from "@/lib/config.schema";

export type NodePresentation = {
  id: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  color?: string;
};

/**
 * Returns a NEW manifest with presentation.nodes set from `presentations`.
 * Validated against flowPresentationSchema before returning.
 * Node-id integrity: drops any presentation whose id is not a real node in
 * the manifest (manifest.nodes[].id or steps[].id). Preserves every other
 * manifest field untouched (logic-only DSL stays intact). Does not mutate
 * the input manifest.
 */
export function applyPresentation(
  manifest: FlowYamlV1,
  presentations: NodePresentation[],
): FlowYamlV1 {
  const knownIds = new Set<string>([
    ...(manifest.nodes ?? []).map((n) => n.id),
    ...(manifest.steps ?? []).map((s) => s.id),
  ]);

  const filtered = presentations.filter((p) => knownIds.has(p.id));

  // Validate the presentation section with the schema before embedding it.
  const parsed = flowPresentationSchema.parse({ nodes: filtered });

  return {
    ...manifest,
    presentation: parsed,
  };
}

/**
 * Reads manifest.presentation?.nodes ?? [] as NodePresentation[]. Inverse of
 * applyPresentation.
 */
export function readPresentation(manifest: FlowYamlV1): NodePresentation[] {
  return manifest.presentation?.nodes ?? [];
}
