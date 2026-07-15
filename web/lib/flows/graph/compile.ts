import type { NodeAttemptType } from "@/lib/db/schema";
import type {
  FlowYamlV1,
  GateDef,
  NodeDef,
  RunnerSlot,
} from "@/lib/config.schema";

import pino from "pino";

import { parseWhen } from "./when-grammar";

import { TERMINAL_TRANSITION_TARGET } from "@/lib/config.schema";
import { MaisterError } from "@/lib/errors-core";
import {
  findMustacheClose,
  parseDefaultExpression,
} from "@/lib/flows/template-expressions";

const log = pino({
  name: "flow-compile",
  level: process.env.LOG_LEVEL ?? "info",
});

export type CompiledNode = {
  id: string;
  nodeType: NodeAttemptType;
  source: { kind: "node"; node: NodeDef };
  // decision/outcome -> target node id, or TERMINAL_TRANSITION_TARGET ("done").
  transitions: Record<string, string>;
  gates: GateDef[];
  rework?: NodeDef["rework"];
  finishHuman?: NonNullable<NodeDef["finish"]>["human"];
  // M11c (ADR-032): the node's typed settings threaded onto the compiled node
  // so the per-node enforcement gate reads it without re-parsing the manifest.
  settings?: NodeDef["settings"];
  // M19 crash-recover (ADR-034): whether an operator Recover may re-dispatch
  // this node after a crash. Defaults false; only meaningful for session-less
  // node kinds (ai_coding recovers via `--resume`).
  retrySafe: boolean;
  // M12 (T3.1): typed artifact requires/produces from the NodeDef. Present only
  input?: NodeDef["input"];
  output?: NodeDef["output"];
  // M38 (ADR-103): node-level dynamic-routing table. Present only for graph nodes
  // declaring `decide`; the runtime outcome site reads it.
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

// M42 (ADR-114): node types that run as a parent ACP session (and therefore
// belong to a session). consensus is a child-run fan-out (excluded); cli/check
// are shell; human/form are HITL.
const RUNNER_BEARING_NODE_TYPES: ReadonlySet<NodeAttemptType> = new Set([
  "ai_coding",
  "orchestrator",
  "judge",
]);

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

// ADR-118: forward-reachable node-id closure starting from `seeds`, following
// each node's `transitions` targets (the terminal "done" target is not a node).
// `seeds` are included (a rework re-entry target is itself reachable).
function forwardReachableNodeIds(
  seeds: readonly string[],
  nodesById: Map<string, NodeDef>,
): Set<string> {
  const reachable = new Set<string>();
  const queue = [...seeds];

  while (queue.length > 0) {
    const id = queue.shift()!;

    if (reachable.has(id)) continue;
    reachable.add(id);

    const node = nodesById.get(id);

    if (node === undefined) continue;

    for (const target of Object.values(node.transitions ?? {})) {
      if (target !== TERMINAL_TRANSITION_TARGET && !reachable.has(target)) {
        queue.push(target);
      }
    }
  }

  return reachable;
}

// ADR-118: compile/load-time verification of `rework.onExhaustion` (a loop
// node's exhaustion-routing key) and `rework.resetTargets` (a human node's
// loop-counter reset list). Throws MaisterError("CONFIG") on any violation.
// Both fields live INSIDE `rework`, so "declared without a rework block" is
// structurally impossible (the schema prevents it). The runtime allow-list guard
// re-asserts onExhaustion ∈ transitions as defense in depth.
function verifyReworkReset(
  node: NodeDef,
  nodesById: Map<string, NodeDef>,
): void {
  const rework = node.rework;

  if (rework === undefined) return;

  const onExhaustion = rework.onExhaustion;

  if (onExhaustion !== undefined) {
    const transitions = node.transitions ?? {};
    const transitionKeys = Object.keys(transitions);

    if (!transitionKeys.includes(onExhaustion)) {
      throw new MaisterError(
        "CONFIG",
        `node "${node.id}" rework.onExhaustion "${onExhaustion}" is not a declared transition outcome (transition keys: ${transitionKeys.join(", ") || "(none)"})`,
      );
    }

    // onExhaustion must route OUT of the loop, not back into it. If its target is
    // one of this node's own rework.allowedTargets, exhaustion re-enters the very
    // loop it just exhausted (no reset in between) and dies at the loop-top
    // backstop on re-entry — a runtime CONFIG where a compile refusal is clearer.
    // The intended pattern routes onExhaustion to a node OUTSIDE the loop (e.g. a
    // human node, which may itself re-baseline the loop via rework.resetTargets).
    const onExhaustionTarget = transitions[onExhaustion];

    if (rework.allowedTargets.includes(onExhaustionTarget)) {
      throw new MaisterError(
        "CONFIG",
        `node "${node.id}" rework.onExhaustion "${onExhaustion}" routes to "${onExhaustionTarget}", which is one of this node's rework.allowedTargets [${rework.allowedTargets.join(", ")}] — exhaustion must route OUT of the loop, not back into it`,
      );
    }
  }

  const resetTargets = rework.resetTargets;

  if (resetTargets !== undefined) {
    const reachable = forwardReachableNodeIds(rework.allowedTargets, nodesById);

    for (const targetId of resetTargets) {
      const target = nodesById.get(targetId);

      if (target === undefined) {
        throw new MaisterError(
          "CONFIG",
          `node "${node.id}" rework.resetTargets references unknown node id "${targetId}"`,
        );
      }
      if (target.rework === undefined) {
        throw new MaisterError(
          "CONFIG",
          `node "${node.id}" rework.resetTargets target "${targetId}" is not a rework-loop node (it has no \`rework\` block, so it has no counter to reset)`,
        );
      }
      if (!reachable.has(targetId)) {
        throw new MaisterError(
          "CONFIG",
          `node "${node.id}" rework.resetTargets target "${targetId}" is not reachable from rework.allowedTargets [${rework.allowedTargets.join(", ")}] — a reset must target a loop the rework re-enters`,
        );
      }
    }

    log.debug(
      { nodeId: node.id, resetTargets, allowedTargets: rework.allowedTargets },
      "[rework.resetTargets] verified targets are reachable rework-loop nodes",
    );
  }
}

const TOP_LEVEL_TEMPLATE_KEY_RE = /^[A-Za-z0-9_-]+$/;

function templateReadsTopLevelVar(template: string, variable: string): boolean {
  let cursor = 0;

  while (cursor < template.length) {
    const start = template.indexOf("{{", cursor);

    if (start === -1) return false;
    const close = findMustacheClose(template, start);

    if (close === -1) return false;

    const rawTag = template.slice(start + 2, close).trim();
    const expression = parseDefaultExpression(rawTag);
    const path = expression?.path ?? rawTag;

    if (path === variable) return true;
    cursor = close + 2;
  }

  return false;
}

function rendererTemplate(
  node: NodeDef,
): { field: string; value: string } | null {
  switch (node.type) {
    case "ai_coding":
    case "judge":
    case "orchestrator":
      return { field: "action.prompt", value: node.action.prompt };
    case "cli":
    case "check":
      return { field: "action.command", value: node.action.command };
    default:
      return null;
  }
}

// ADR-138: every human-review rework must be able to deliver the exact packet
// to each declared destination. Runtime re-checks open legacy gates, while new
// manifests fail at compile/load before an agent session can start.
function verifyHumanReviewFeedbackConsumers(
  node: NodeDef,
  nodesById: Map<string, NodeDef>,
): void {
  if (node.type !== "human" || node.rework === undefined) return;

  const reworkDecisionTargets = Object.values(node.transitions ?? {}).filter(
    (target) => node.rework?.allowedTargets.includes(target),
  );

  if (reworkDecisionTargets.length === 0) return;

  const commentsVar =
    node.rework.commentsVar ?? node.finish?.human?.commentsVar;

  if (
    typeof commentsVar !== "string" ||
    !TOP_LEVEL_TEMPLATE_KEY_RE.test(commentsVar)
  ) {
    throw new MaisterError(
      "CONFIG",
      `human review node "${node.id}" needs a valid top-level commentsVar for rework feedback`,
    );
  }

  for (const targetId of node.rework.allowedTargets) {
    const target = nodesById.get(targetId);

    if (!target) {
      throw new MaisterError(
        "CONFIG",
        `human review node "${node.id}" rework target "${targetId}" does not exist for commentsVar "${commentsVar}"`,
      );
    }

    const template = rendererTemplate(target);

    if (!template) {
      throw new MaisterError(
        "CONFIG",
        `human review node "${node.id}" rework target "${targetId}" cannot consume commentsVar "${commentsVar}" (supported target types: ai_coding, judge, orchestrator, cli, check)`,
      );
    }
    if (!templateReadsTopLevelVar(template.value, commentsVar)) {
      throw new MaisterError(
        "CONFIG",
        `human review node "${node.id}" rework target "${targetId}" must render commentsVar "${commentsVar}" in ${template.field}`,
      );
    }
  }

  log.debug(
    {
      nodeId: node.id,
      targets: node.rework.allowedTargets,
      commentsVar,
    },
    "[review-feedback] verified rework targets consume feedback",
  );
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

  // ADR-118: raw NodeDef lookup for rework.resetTargets graph-context checks.
  const nodesById = new Map(graphNodes.map((n) => [n.id, n]));

  for (const node of graphNodes) {
    verifyDecideAndOnMismatch(node);
    verifyReworkReset(node, nodesById);
    verifyHumanReviewFeedbackConsumers(node, nodesById);

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

// Compile a validated graph-only manifest into its runtime traversal model.
export function compileManifest(manifest: FlowYamlV1): FlowGraph {
  return compileGraph(
    manifest.nodes,
    manifest.verdict_calibration,
    manifest.sessions,
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
