import type { NodeAttemptType } from "@/lib/db/schema";
import type {
  FlowYamlV1,
  GateDef,
  NodeDef,
  RunnerSlot,
  Step,
} from "@/lib/config.schema";

import pino from "pino";

import { parseWhen } from "./when-grammar";

import { TERMINAL_TRANSITION_TARGET } from "@/lib/config.schema";
import { MaisterError } from "@/lib/errors-core";

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
  // M42 (ADR-114): the logical session this node runs in (one ACP process + one
  // continuous acp_session_id). Set ONLY for runner-bearing nodes
  // (ai_coding / orchestrator / judge); undefined for consensus/cli/check/
  // human/form (they spawn no parent ACP session).
  session?: string;
};

// M42 (ADR-114): a logical session in the run's session set — its name and
// declared runner config. `runner` is undefined for the implicit `default`
// session with no explicit declaration (resolved via the precedence chain at
// launch).
export type CompiledSession = {
  name: string;
  runner?: RunnerSlot;
};

export type FlowGraph = {
  entry: string;
  order: string[];
  nodes: Map<string, CompiledNode>;
  // M42 (ADR-114): the run's session set — every distinct session a
  // runner-bearing node belongs to, keyed by session name.
  sessions: Map<string, CompiledSession>;
};

const STEP_TYPE_TO_NODE_TYPE: Record<Step["type"], NodeAttemptType> = {
  cli: "cli",
  agent: "ai_coding",
  guard: "guard",
  human: "human",
};

// M42 (ADR-114): node types that run as a parent ACP session (and therefore
// belong to a session). consensus is a child-run fan-out (excluded); cli/check
// are shell; human/form are HITL.
const RUNNER_BEARING_NODE_TYPES: ReadonlySet<NodeAttemptType> = new Set([
  "ai_coding",
  "orchestrator",
  "judge",
]);

// Compile a linear `steps[]` manifest into a chain of single-action nodes:
// each step -> node with `transitions.success -> next` (last -> "done"), no
// rework. Preserves behavioral parity with the pre-M11a linear runner.
function compileLinear(steps: Step[]): FlowGraph {
  const order = steps.map((s) => s.id);
  const nodes = new Map<string, CompiledNode>();
  // Legacy linear flows are single-runner-per-run: every agent step shares the
  // implicit `default` session (M42).
  const sessions = new Map<string, CompiledSession>();

  steps.forEach((step, i) => {
    const next =
      i + 1 < steps.length ? steps[i + 1].id : TERMINAL_TRANSITION_TARGET;
    const nodeType = STEP_TYPE_TO_NODE_TYPE[step.type];
    const session = RUNNER_BEARING_NODE_TYPES.has(nodeType)
      ? "default"
      : undefined;

    if (session) sessions.set("default", { name: "default" });

    nodes.set(step.id, {
      id: step.id,
      nodeType,
      source: { kind: "step", step },
      transitions: { success: next },
      gates: [],
      retrySafe: step.retry_safe ?? false,
      session,
    });
  });

  return { entry: steps[0].id, order, nodes, sessions };
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
    // A verdict-routing node routes on the verdict surfaced by its
    // verdict-producing gate. Without exactly one ai_judgment/skill_check gate
    // there is no verdict (every `when` misses → routing silently falls to
    // `default`); with more than one the surfaced verdict is ambiguous
    // (last-gate-wins at runtime). Require exactly one.
    const verdictGates = (node.pre_finish?.gates ?? []).filter(
      (g) => g.kind === "ai_judgment" || g.kind === "skill_check",
    );

    if (verdictGates.length !== 1) {
      throw new MaisterError(
        "CONFIG",
        `node "${node.id}" decide:{from:verdict} needs exactly one ai_judgment/skill_check gate to route on (found ${verdictGates.length})`,
      );
    }

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
  } else if (decide) {
    // from: output.<path> routes on the node's validated structured output, so
    // output.result must be declared — otherwise `vars` is empty and routing
    // always resolves to undefined (a silent terminal).
    if (node.output?.result === undefined) {
      throw new MaisterError(
        "CONFIG",
        `node "${node.id}" decide:{from:${decide.from}} needs output.result declared (the structured output the path resolves against)`,
      );
    }
  }

  const onMismatch = node.output?.result?.on_mismatch;

  if (onMismatch !== undefined) {
    if (node.rework === undefined) {
      throw new MaisterError(
        "CONFIG",
        `node "${node.id}" declares output.result.on_mismatch but no \`rework\` block (required for maxLoops/commentsVar/workspace policy)`,
      );
    }

    // The structured-output validation error is injected into rework.commentsVar
    // for the next attempt's prompt; without it the rework re-runs blind (a
    // deterministic node then just re-fails to maxLoops).
    if (node.rework.commentsVar === undefined) {
      throw new MaisterError(
        "CONFIG",
        `node "${node.id}" declares output.result.on_mismatch but rework.commentsVar is unset — the validation error is injected there, so the rework needs it`,
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
  manifestSessions: FlowYamlV1["sessions"],
): FlowGraph {
  const order = graphNodes.map((n) => n.id);
  const nodes = new Map<string, CompiledNode>();
  const sessions = new Map<string, CompiledSession>();
  const sessionDefs = manifestSessions ?? {};
  const flowConfidenceMin = flowVerdictCalibration?.confidence_min;

  const addSession = (name: string, runner?: RunnerSlot): void => {
    if (!sessions.has(name)) {
      sessions.set(name, {
        name,
        ...(runner !== undefined ? { runner } : {}),
      });
    }
  };

  // M42 (ADR-114): node with `session:` joins that named group; a runner-bearing
  // node with `settings.runner` and no `session:` gets a SOLO session (keyed by
  // its node id); otherwise the implicit `default` session.
  const assignSession = (node: NodeDef): string | undefined => {
    if (!RUNNER_BEARING_NODE_TYPES.has(node.type)) return undefined;

    if (node.session) {
      addSession(node.session, sessionDefs[node.session]?.runner);

      return node.session;
    }

    const settingsRunner = (
      node.settings as { runner?: RunnerSlot } | undefined
    )?.runner;

    if (settingsRunner !== undefined) {
      addSession(node.id, settingsRunner);

      return node.id;
    }

    addSession("default", sessionDefs.default?.runner);

    return "default";
  };

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
      session: assignSession(node),
    });
  }

  return { entry: graphNodes[0].id, order, nodes, sessions };
}

// Normalize either manifest form into a FlowGraph. The manifest has already
// passed `loadFlowManifest` validation (exactly one of steps/nodes, graph
// cross-references resolve), so this is a pure structural transform.
export function compileManifest(manifest: FlowYamlV1): FlowGraph {
  if (manifest.nodes && manifest.nodes.length > 0) {
    return compileGraph(
      manifest.nodes,
      manifest.verdict_calibration,
      manifest.sessions,
    );
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
