import type { FlowYamlV1 } from "@/lib/config.schema";

export type FlowLayoutEntry = {
  x: number;
  y: number;
  width?: number;
  height?: number;
  color?: string;
};

export type FlowLayout = Record<string, FlowLayoutEntry>;

/**
 * Project a flow manifest's authored `presentation` section (ADR-064) into the
 * nodeId -> {x,y,width?,height?,color?} map the flow-graph view consumes. Only
 * entries that declare both coordinates are positioned; every other node is
 * dagre-seeded at render, and entries for ids absent from the topology are
 * harmless (no phantom nodes — the view merges over the compiled node set).
 * Size/color ride along on positioned entries (the editor's `moveNode` always
 * writes x+y together, so authored size/color reach the canvas + read-only view
 * via this map). Pure, no I/O.
 */
export function presentationLayout(manifest: FlowYamlV1): FlowLayout {
  const map: FlowLayout = {};

  for (const entry of manifest.presentation?.nodes ?? []) {
    if (typeof entry.x === "number" && typeof entry.y === "number") {
      map[entry.id] = {
        x: entry.x,
        y: entry.y,
        ...(typeof entry.width === "number" ? { width: entry.width } : {}),
        ...(typeof entry.height === "number" ? { height: entry.height } : {}),
        ...(typeof entry.color === "string" ? { color: entry.color } : {}),
      };
    }
  }

  return map;
}
