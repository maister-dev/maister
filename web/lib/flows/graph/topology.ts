import type { GateDef } from "@/lib/config.schema";
import type { FlowGraph } from "@/lib/flows/graph/compile";

import { TERMINAL_TRANSITION_TARGET } from "@/lib/config.schema";

// Client-safe topology builder: pure transform from a compiled (logic-only)
// FlowGraph to a renderable {nodes, edges} shape. No runtime server-side
// dependency (no db/node:*/fs guard) — it imports only `@/lib/config.schema`
// (zod-only, client-safe) and the `FlowGraph` TYPE from the now-client-safe
// `compile`, so a client live-preview can compile yaml→graph→topology in the
// browser (T3.1). `@/lib/queries/flow-graph-view` re-exports these for
// unchanged server callers.

export type GraphNodeRole =
  | "agent"
  | "command"
  | "check"
  | "judge"
  | "human"
  | "form"
  | "terminal"
  | "other";

export type GraphEdgeRole =
  | "success"
  | "default"
  | "rework"
  | "reject"
  | "takeover"
  | "approve"
  | "other";

export interface DeclaredGateSummary {
  total: number;
  blocking: number;
  advisory: number;
  kinds: string[];
}

export interface GraphTopologyNode {
  id: string;
  nodeType: string;
  label: string;
  displayLabel: string;
  nodeTypeLabel: string;
  nodeRole: GraphNodeRole;
  declaredGateSummary: DeclaredGateSummary;
}

export interface GraphTopologyEdge {
  id: string;
  source: string;
  target: string;
  outcome: string;
  displayLabel: string;
  edgeRole: GraphEdgeRole;
}

export interface GraphTopology {
  nodes: GraphTopologyNode[];
  edges: GraphTopologyEdge[];
}

function humanizeToken(value: string): string {
  const spaced = value.replace(/[-_]+/g, " ").trim();

  if (spaced.length === 0) return value;

  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function nodeRoleForType(nodeType: string): GraphNodeRole {
  switch (nodeType) {
    case "ai_coding":
      return "agent";
    case "cli":
      return "command";
    case "check":
    case "guard":
      return "check";
    case "judge":
      return "judge";
    case "human":
      return "human";
    case "form":
      return "form";
    default:
      return "other";
  }
}

function nodeTypeLabelForRole(role: GraphNodeRole): string {
  switch (role) {
    case "agent":
      return "Agent";
    case "command":
      return "Command";
    case "check":
      return "Check";
    case "judge":
      return "Judge";
    case "human":
      return "Human review";
    case "form":
      return "Form";
    case "terminal":
      return "Terminal";
    default:
      return "Other";
  }
}

function edgeRoleForOutcome(outcome: string): GraphEdgeRole {
  switch (outcome) {
    case "success":
      return "success";
    case "default":
      return "default";
    case "rework":
      return "rework";
    case "reject":
      return "reject";
    case "takeover":
      return "takeover";
    case "approve":
      return "approve";
    default:
      return "other";
  }
}

function declaredGateSummary(gates: GateDef[]): DeclaredGateSummary {
  const kinds: string[] = [];

  for (const gate of gates) {
    if (!kinds.includes(gate.kind)) kinds.push(gate.kind);
  }

  return {
    total: gates.length,
    blocking: gates.filter((gate) => gate.mode === "blocking").length,
    advisory: gates.filter((gate) => gate.mode === "advisory").length,
    kinds,
  };
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

    const nodeRole = nodeRoleForType(node.nodeType);

    nodes.push({
      id,
      nodeType: node.nodeType,
      label: id,
      displayLabel: humanizeToken(id),
      nodeTypeLabel: nodeTypeLabelForRole(nodeRole),
      nodeRole,
      declaredGateSummary: declaredGateSummary(node.gates),
    });

    for (const [outcome, target] of Object.entries(node.transitions)) {
      if (target === TERMINAL_TRANSITION_TARGET) continue;

      edges.push({
        id: `${id}:${outcome}`,
        source: id,
        target,
        outcome,
        displayLabel: humanizeToken(outcome),
        edgeRole: edgeRoleForOutcome(outcome),
      });
    }
  }

  return { nodes, edges };
}
