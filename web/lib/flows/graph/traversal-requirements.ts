import type { FlowGraph } from "./compile";

/** Classify the actual action/gate dispatch paths before selecting traversal ownership. */
export function flowTraversalRequirements(graph: FlowGraph): Readonly<{
  ownedPrompts: boolean;
  cliActions: boolean;
}> {
  const nodes = [...graph.nodes.values()];

  return {
    ownedPrompts: nodes.some(
      (node) =>
        ["ai_coding", "judge", "orchestrator", "consensus"].includes(
          node.nodeType,
        ) ||
        node.gates.some(
          (gate) => gate.kind === "ai_judgment" || gate.kind === "skill_check",
        ),
    ),
    cliActions: nodes.some(
      (node) =>
        node.nodeType === "cli" ||
        node.nodeType === "check" ||
        node.gates.some((gate) => gate.kind === "command_check"),
    ),
  };
}
