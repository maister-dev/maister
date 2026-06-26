import type {
  DeclaredGateSummary,
  GraphEdgeRole,
  GraphNodeRole,
  GraphTopology,
} from "@/lib/queries/flow-graph-view";
import type { Edge, Node } from "@xyflow/react";

import {
  NODE_HEIGHT,
  NODE_WIDTH,
  layoutGraph,
} from "@/lib/board/evidence-graph-layout";
import { edgeOutcomeStyle } from "@/lib/flows/edge-style";

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
  displayLabel: string;
  nodeTypeLabel: string;
  nodeRole: GraphNodeRole;
  declaredGateSummary: DeclaredGateSummary;
  // M42 (ADR-114): the named shared session this node joins (canvas grouping chip).
  sessionName?: string;
  // Additive presentation styling (ADR-064): authored size + color, threaded
  // into `data` so both the read-only view and the editor canvas body can paint
  // them. Kept separate from React Flow's measured Node.width/height (which the
  // override also sets, for edge geometry) so only author-set dims drive the box.
  presentationColor?: string;
  presentationWidth?: number;
  presentationHeight?: number;
};

export type FlowLayoutOverride = {
  x: number;
  y: number;
  width?: number;
  height?: number;
  color?: string;
};

export type FlowEdgeData = {
  outcome: string;
  displayLabel: string;
  edgeRole: GraphEdgeRole;
};

function edgeClassName(role: GraphEdgeRole): string | undefined {
  switch (role) {
    case "rework":
    case "reject":
    case "takeover":
      return `flow-edge--${role}`;
    default:
      return undefined;
  }
}

function edgeAnimated(role: GraphEdgeRole): boolean {
  return role === "rework" || role === "reject" || role === "takeover";
}

// Map the server graph topology onto React Flow nodes/edges, run the dagre LR
// baseline, then apply stored layout overrides on top (override x/y wins;
// un-overridden nodes keep the dagre seed; overrides for ids absent from the
// topology are ignored — no phantom nodes). An override may also carry authored
// width/height (applied as node size) and color (applied as node style +
// `data.presentationColor` for the body). Pure, no I/O.
export function toFlowGraphView(
  topology: GraphTopology,
  layoutOverrides: Record<string, FlowLayoutOverride>,
): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = topology.nodes.map((n) => {
    const data: FlowNodeData = {
      label: n.label,
      nodeType: n.nodeType,
      displayLabel: n.displayLabel,
      nodeTypeLabel: n.nodeTypeLabel,
      nodeRole: n.nodeRole,
      declaredGateSummary: n.declaredGateSummary,
      ...(n.sessionName ? { sessionName: n.sessionName } : {}),
    };

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
    const data: FlowEdgeData = {
      outcome: e.outcome,
      displayLabel: e.displayLabel,
      edgeRole: e.edgeRole,
    };
    const className = edgeClassName(e.edgeRole);

    return {
      id: e.id,
      source: e.source,
      target: e.target,
      type: "flowEdge",
      data: data as unknown as Record<string, unknown>,
      style: edgeOutcomeStyle(e.edgeRole).style,
      ...(edgeAnimated(e.edgeRole) ? { animated: true } : {}),
      ...(className ? { className } : {}),
    };
  });

  const laid = layoutGraph(nodes, edges);

  const merged: Node[] = laid.map((n) => {
    const override = layoutOverrides[n.id];

    if (!override) return n;

    const next: Node = { ...n, position: { x: override.x, y: override.y } };
    const dataPatch: Record<string, unknown> = {};

    if (typeof override.width === "number") {
      next.width = override.width;
      dataPatch.presentationWidth = override.width;
    }
    if (typeof override.height === "number") {
      next.height = override.height;
      dataPatch.presentationHeight = override.height;
    }
    if (typeof override.color === "string") {
      next.style = { ...n.style, borderColor: override.color };
      dataPatch.presentationColor = override.color;
    }
    if (Object.keys(dataPatch).length > 0) {
      next.data = { ...n.data, ...dataPatch };
    }

    return next;
  });

  return { nodes: merged, edges };
}
