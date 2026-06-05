import "server-only";

import type { FlowGraph } from "@/lib/flows/graph/compile";

import { TERMINAL_TRANSITION_TARGET } from "@/lib/config.schema";

export interface GraphTopologyNode {
  id: string;
  nodeType: string;
  label: string;
}

export interface GraphTopologyEdge {
  id: string;
  source: string;
  target: string;
  outcome: string;
}

export interface GraphTopology {
  nodes: GraphTopologyNode[];
  edges: GraphTopologyEdge[];
}

/**
 * Pure topology transform: the compiled (logic-only) FlowGraph -> a renderable
 * {nodes, edges} shape with no x/y. Node order follows compiled.order. Each
 * outcome transition becomes one edge, except the terminal "done" sentinel,
 * which carries no edge. The node id is the label — the step/node DSL declares
 * no separate label field (a label is a Wave-3 graph-editor concern).
 */
export function buildGraphTopology(compiled: FlowGraph): GraphTopology {
  const nodes: GraphTopologyNode[] = [];
  const edges: GraphTopologyEdge[] = [];

  for (const id of compiled.order) {
    const node = compiled.nodes.get(id);

    if (!node) continue;

    nodes.push({ id, nodeType: node.nodeType, label: id });

    for (const [outcome, target] of Object.entries(node.transitions)) {
      if (target === TERMINAL_TRANSITION_TARGET) continue;

      edges.push({ id: `${id}:${outcome}`, source: id, target, outcome });
    }
  }

  return { nodes, edges };
}
