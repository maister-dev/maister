import "server-only";

import type { NodeAttemptType } from "@/lib/db/schema";
import type { FlowYamlV1, GateDef, NodeDef, Step } from "@/lib/config.schema";

import { TERMINAL_TRANSITION_TARGET } from "@/lib/config.schema";
import { MaisterError } from "@/lib/errors";

// A node in the compiled graph. It carries either the original linear `Step`
// (compiled-linear back-compat — executed via the existing per-step runners) or
// the manifest `NodeDef` (graph v1). Both forms expose the same traversal
// surface: transitions + optional gates/rework/finishHuman.
export type CompiledNode = {
  id: string;
  nodeType: NodeAttemptType;
  source: { kind: "step"; step: Step } | { kind: "node"; node: NodeDef };
  // decision/outcome -> target node id, or TERMINAL_TRANSITION_TARGET ("done").
  transitions: Record<string, string>;
  gates: GateDef[];
  rework?: NodeDef["rework"];
  finishHuman?: NonNullable<NodeDef["finish"]>["human"];
  // M11c (ADR-032): the node's typed settings threaded onto the compiled node
  // so the per-node enforcement gate reads it without re-parsing the manifest.
  // Compiled-linear nodes carry no settings (undefined).
  settings?: NodeDef["settings"];
  // M19 crash-recover (ADR-034): whether an operator Recover may re-dispatch
  // this node after a crash. Defaults false; only meaningful for session-less
  // node kinds (ai_coding recovers via `--resume`).
  retrySafe: boolean;
  // M12 (T3.1): typed artifact requires/produces from the NodeDef. Present only
  // for graph-based nodes (source.kind === "node"); compiled-linear nodes leave
  // these undefined for backward compat.
  input?: NodeDef["input"];
  output?: NodeDef["output"];
};

export type FlowGraph = {
  entry: string;
  order: string[];
  nodes: Map<string, CompiledNode>;
};

const STEP_TYPE_TO_NODE_TYPE: Record<Step["type"], NodeAttemptType> = {
  cli: "cli",
  agent: "ai_coding",
  guard: "guard",
  human: "human",
};

// Compile a linear `steps[]` manifest into a chain of single-action nodes:
// each step -> node with `transitions.success -> next` (last -> "done"), no
// rework. Preserves behavioral parity with the pre-M11a linear runner.
function compileLinear(steps: Step[]): FlowGraph {
  const order = steps.map((s) => s.id);
  const nodes = new Map<string, CompiledNode>();

  steps.forEach((step, i) => {
    const next =
      i + 1 < steps.length ? steps[i + 1].id : TERMINAL_TRANSITION_TARGET;

    nodes.set(step.id, {
      id: step.id,
      nodeType: STEP_TYPE_TO_NODE_TYPE[step.type],
      source: { kind: "step", step },
      transitions: { success: next },
      gates: [],
      retrySafe: step.retry_safe ?? false,
    });
  });

  return { entry: steps[0].id, order, nodes };
}

function compileGraph(graphNodes: NodeDef[]): FlowGraph {
  const order = graphNodes.map((n) => n.id);
  const nodes = new Map<string, CompiledNode>();

  for (const node of graphNodes) {
    nodes.set(node.id, {
      id: node.id,
      nodeType: node.type,
      source: { kind: "node", node },
      transitions: { ...(node.transitions ?? {}) },
      gates: node.pre_finish?.gates ?? [],
      rework: node.rework,
      finishHuman: node.finish?.human,
      settings: node.settings,
      retrySafe: node.retry_safe ?? false,
      input: node.input,
      output: node.output,
    });
  }

  return { entry: graphNodes[0].id, order, nodes };
}

// Normalize either manifest form into a FlowGraph. The manifest has already
// passed `loadFlowManifest` validation (exactly one of steps/nodes, graph
// cross-references resolve), so this is a pure structural transform.
export function compileManifest(manifest: FlowYamlV1): FlowGraph {
  if (manifest.nodes && manifest.nodes.length > 0) {
    return compileGraph(manifest.nodes);
  }
  if (manifest.steps && manifest.steps.length > 0) {
    return compileLinear(manifest.steps);
  }

  throw new MaisterError(
    "CONFIG",
    "flow manifest has neither steps[] nor nodes[] to compile",
  );
}

// Resolve the next node id for a finished node given its chosen outcome
// (e.g. "success", "approve", "rework"). Returns null when the outcome is
// terminal ("done") or has no declared transition (treated as terminal).
export function resolveTransition(
  node: CompiledNode,
  outcome: string,
): string | null {
  const target = node.transitions[outcome];

  if (target === undefined || target === TERMINAL_TRANSITION_TARGET)
    return null;

  return target;
}
