import type { GraphTopology } from "@/lib/queries/flow-graph-view";
import type { Edge, Node } from "@xyflow/react";

import {
  NODE_HEIGHT,
  NODE_WIDTH,
  layoutGraph,
} from "@/lib/board/evidence-graph-layout";

export type FlowChipColor =
  | "default"
  | "success"
  | "warning"
  | "danger"
  | "accent";

export const RUN_TERMINAL_STATUSES = [
  "Done",
  "Failed",
  "Abandoned",
  "Crashed",
] as const;

export function isTerminalRunStatus(status: string): boolean {
  return (RUN_TERMINAL_STATUSES as readonly string[]).includes(status);
}

// Map a node's highest-attempt status onto a HeroUI <Chip color>. Mirrors the
// evidence-graph colorForState; the current node bumps an unresolved status to
// accent for active emphasis but never overrides a resolved status.
export function colorForNodeStatus(
  status: string,
  isCurrent: boolean,
): FlowChipColor {
  switch (status) {
    case "Running":
      return "accent";
    case "Succeeded":
      return "success";
    case "Failed":
      return "danger";
    case "NeedsInput":
    case "Reworked":
      return "warning";
    case "Stale":
    case "Pending":
      return isCurrent ? "accent" : "default";
    default:
      return isCurrent ? "accent" : "default";
  }
}

export type FlowNodeData = {
  label: string;
  nodeType: string;
};

export type FlowEdgeData = {
  outcome: string;
};

// Map the server graph topology onto React Flow nodes/edges, run the dagre LR
// baseline, then apply stored layout overrides on top (override x/y wins;
// un-overridden nodes keep the dagre seed; overrides for ids absent from the
// topology are ignored — no phantom nodes). Pure, no I/O.
export function toFlowGraphView(
  topology: GraphTopology,
  layoutOverrides: Record<string, { x: number; y: number }>,
): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = topology.nodes.map((n) => {
    const data: FlowNodeData = { label: n.label, nodeType: n.nodeType };

    return {
      id: n.id,
      type: "flowNode",
      position: { x: 0, y: 0 },
      data: data as unknown as Record<string, unknown>,
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
    };
  });

  const edges: Edge[] = topology.edges.map((e) => {
    const data: FlowEdgeData = { outcome: e.outcome };

    return {
      id: e.id,
      source: e.source,
      target: e.target,
      data: data as unknown as Record<string, unknown>,
    };
  });

  const laid = layoutGraph(nodes, edges);

  const merged: Node[] = laid.map((n) => {
    const override = layoutOverrides[n.id];

    return override ? { ...n, position: { x: override.x, y: override.y } } : n;
  });

  return { nodes: merged, edges };
}
