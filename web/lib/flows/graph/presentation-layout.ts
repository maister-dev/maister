import type { FlowYamlV1 } from "@/lib/config.schema";

export type FlowLayout = Record<string, { x: number; y: number }>;

/**
 * Project a flow manifest's authored `presentation` section (ADR-064) into the
 * nodeId -> {x,y} map the flow-graph view consumes. Only entries that declare
 * both coordinates are positioned; every other node is dagre-seeded at render,
 * and entries for ids absent from the topology are harmless (no phantom nodes —
 * the view merges over the compiled node set). Size/color are accepted in the
 * manifest but not projected here: the live run view colors by node status, so
 * authored color must not override it. Pure, no I/O.
 */
export function presentationLayout(manifest: FlowYamlV1): FlowLayout {
  const map: FlowLayout = {};

  for (const entry of manifest.presentation?.nodes ?? []) {
    if (typeof entry.x === "number" && typeof entry.y === "number") {
      map[entry.id] = { x: entry.x, y: entry.y };
    }
  }

  return map;
}
