import type {
  EvidenceEdge as SrcEdge,
  EvidenceGraph,
  EvidenceNode as SrcNode,
} from "@/lib/queries/evidence-graph";
import type { Edge, Node } from "@xyflow/react";

import dagre from "@dagrejs/dagre";

const NODE_WIDTH = 180;
const NODE_HEIGHT = 60;

// Minimal structural label shape consumed by the pure label helpers. The
// component's EvidenceGraphLabels is a superset of this.
export type EvidenceTextLabels = {
  stateCurrent: string;
  stateStale: string;
  stateSuperseded: string;
  stateFailed: string;
  stateSkipped: string;
  kindTaskInput: string;
  kindNodeAttempt: string;
  kindArtifact: string;
  kindGate: string;
  kindDecision: string;
};

// Translate a node/validity state token. Falls back to the raw token for
// non-validity states (e.g. gate `passed`, attempt `Succeeded`) where no
// catalog key exists — never invents keys.
export function stateLabel(
  state: string | null,
  labels: EvidenceTextLabels,
): string {
  switch (state) {
    case "current":
      return labels.stateCurrent;
    case "stale":
      return labels.stateStale;
    case "superseded":
      return labels.stateSuperseded;
    case "failed":
      return labels.stateFailed;
    case "skipped":
      return labels.stateSkipped;
    default:
      return state ?? "";
  }
}

// Translate an evidence node-kind token.
export function kindLabel(
  kind: SrcNode["kind"],
  labels: EvidenceTextLabels,
): string {
  switch (kind) {
    case "task-input":
      return labels.kindTaskInput;
    case "node-attempt":
      return labels.kindNodeAttempt;
    case "artifact":
      return labels.kindArtifact;
    case "gate":
      return labels.kindGate;
    case "decision":
      return labels.kindDecision;
    default:
      return kind;
  }
}

export type EvidenceNodeData = {
  kind: SrcNode["kind"];
  label: string;
  state: string | null;
  meta: Record<string, unknown>;
  artifactId?: string;
};

export type EvidenceEdgeData = {
  kind: SrcEdge["kind"];
  dashed: boolean;
};

// Map the server evidence-graph DTO onto React Flow nodes/edges. Pure, no I/O.
export function toFlowGraph(graph: EvidenceGraph): {
  nodes: Node[];
  edges: Edge[];
} {
  const nodes: Node[] = graph.nodes.map((n) => {
    const artifactId =
      typeof n.meta.artifactId === "string" ? n.meta.artifactId : undefined;
    const data: EvidenceNodeData = {
      kind: n.kind,
      label: n.label,
      state: n.state,
      meta: n.meta,
      ...(artifactId ? { artifactId } : {}),
    };

    return {
      id: n.id,
      type: "evidence",
      position: { x: 0, y: 0 },
      data: data as unknown as Record<string, unknown>,
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
    };
  });

  const edges: Edge[] = graph.edges.map((e) => {
    const dashed = e.kind === "supersession";
    const data: EvidenceEdgeData = { kind: e.kind, dashed };

    return {
      id: e.id,
      source: e.source,
      target: e.target,
      data: data as unknown as Record<string, unknown>,
      ...(dashed ? { style: { strokeDasharray: "6 4" } } : {}),
    };
  });

  return { nodes, edges };
}

// Deterministic dagre LR layout — writes each node's position from the dagre
// rank/order. No Math.random / Date (both banned in the layout path).
export function layoutGraph(nodes: Node[], edges: Edge[]): Node[] {
  if (nodes.length === 0) return [];

  const g = new dagre.graphlib.Graph();

  g.setGraph({ rankdir: "LR", nodesep: 40, ranksep: 80 });
  g.setDefaultEdgeLabel(() => ({}));

  for (const node of nodes) {
    g.setNode(node.id, {
      width: node.width ?? NODE_WIDTH,
      height: node.height ?? NODE_HEIGHT,
    });
  }

  for (const edge of edges) {
    g.setEdge(edge.source, edge.target);
  }

  dagre.layout(g);

  return nodes.map((node) => {
    const pos = g.node(node.id);
    const width = node.width ?? NODE_WIDTH;
    const height = node.height ?? NODE_HEIGHT;

    return {
      ...node,
      // dagre centers nodes; React Flow positions from the top-left corner.
      position: { x: pos.x - width / 2, y: pos.y - height / 2 },
    };
  });
}
