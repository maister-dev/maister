import type { NodeAttemptType } from "@/lib/db/schema";
import type { FlowYamlV1, GateDef, NodeDef, Step } from "@/lib/config.schema";

import pino from "pino";

import { TERMINAL_TRANSITION_TARGET } from "@/lib/config.schema";
import { MaisterError } from "@/lib/errors-core";

import { parseWhen } from "./when-grammar";

const log = pino({
  name: "flow-compile",
  level: process.env.LOG_LEVEL ?? "info",
});

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
  // M38 (ADR-103): node-level dynamic-routing table. Present only for graph nodes
  // declaring `decide`; the runtime outcome site reads it. Compiled-linear nodes
  // leave it undefined (always "success"-routed).
  decide?: NodeDef["decide"];
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

// M38 (ADR-103): compile/load-time verification of a node's `decide` table and
// `output.result.on_mismatch`. Throws MaisterError("CONFIG") on any violation.
// The dot-path syntax of `decide.from: output.<path>` is already enforced by the
// zod schema; the produced value set is data-dependent → checked at runtime by
// the allow-list guard (T2.4). Here we enforce the parts that need the node's
// transitions/rework context.
function verifyDecideAndOnMismatch(node: NodeDef): void {
  const transitions = node.transitions ?? {};
  const transitionKeys = Object.keys(transitions);

  const decide = node.decide;

  if (decide && decide.from === "verdict") {
    const producible: string[] = [];

    for (const c of decide.cases ?? []) {
      if ("when" in c) {
        const parsed = parseWhen(c.when);

        if (!parsed.ok) {
          throw new MaisterError(
            "CONFIG",
            `node "${node.id}" decide case has an invalid \`when\` predicate: ${parsed.error}`,
          );
        }
      }

      producible.push(c.target);

      if (!transitionKeys.includes(c.target)) {
        throw new MaisterError(
          "CONFIG",
          `node "${node.id}" decide case target "${c.target}" is not a declared transition outcome (transition keys: ${transitionKeys.join(", ") || "(none)"})`,
        );
      }
    }

    log.debug(
      { nodeId: node.id, from: decide.from, producible, transitionKeys },
      "[decide] verified producible outcomes ⊆ transition keys",
    );
  }

  const onMismatch = node.output?.result?.on_mismatch;

  if (onMismatch !== undefined) {
    if (node.rework === undefined) {
      throw new MaisterError(
        "CONFIG",
        `node "${node.id}" declares output.result.on_mismatch but no \`rework\` block (required for maxLoops/commentsVar/workspace policy)`,
      );
    }

    if (onMismatch !== "retry") {
      const target = transitions[onMismatch];

      if (target === undefined) {
        throw new MaisterError(
          "CONFIG",
          `node "${node.id}" on_mismatch "${onMismatch}" has no declared transition`,
        );
      }
      if (!node.rework.allowedTargets.includes(target)) {
        throw new MaisterError(
          "CONFIG",
          `node "${node.id}" on_mismatch "${onMismatch}" routes to "${target}" which is not in rework.allowedTargets [${node.rework.allowedTargets.join(", ")}]`,
        );
      }
    }
  }
}

function compileGraph(
  graphNodes: NodeDef[],
  flowVerdictCalibration: FlowYamlV1["verdict_calibration"],
): FlowGraph {
  const order = graphNodes.map((n) => n.id);
  const nodes = new Map<string, CompiledNode>();
  const flowConfidenceMin = flowVerdictCalibration?.confidence_min;

  for (const node of graphNodes) {
    verifyDecideAndOnMismatch(node);

    const rawGates = node.pre_finish?.gates ?? [];
    const gates: GateDef[] = rawGates.map((g) => {
      const isCalibrationKind =
        g.kind === "ai_judgment" || g.kind === "skill_check";

      // Only fold when: calibration-eligible kind, flow default is set,
      // and the gate has no per-gate confidence_min override.
      if (
        isCalibrationKind &&
        flowConfidenceMin !== undefined &&
        g.calibration?.confidence_min === undefined
      ) {
        return {
          ...g,
          calibration: { ...g.calibration, confidence_min: flowConfidenceMin },
        };
      }

      return g;
    });

    nodes.set(node.id, {
      id: node.id,
      nodeType: node.type,
      source: { kind: "node", node },
      transitions: { ...(node.transitions ?? {}) },
      gates,
      rework: node.rework,
      finishHuman: node.finish?.human,
      settings: node.settings,
      retrySafe: node.retry_safe ?? false,
      input: node.input,
      output: node.output,
      decide: node.decide,
    });
  }

  return { entry: graphNodes[0].id, order, nodes };
}

// Normalize either manifest form into a FlowGraph. The manifest has already
// passed `loadFlowManifest` validation (exactly one of steps/nodes, graph
// cross-references resolve), so this is a pure structural transform.
export function compileManifest(manifest: FlowYamlV1): FlowGraph {
  if (manifest.nodes && manifest.nodes.length > 0) {
    return compileGraph(manifest.nodes, manifest.verdict_calibration);
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
