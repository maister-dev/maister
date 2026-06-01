import "server-only";

import { readFile } from "node:fs/promises";

import Mustache from "mustache";
import pino from "pino";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

import {
  TERMINAL_TRANSITION_TARGET,
  flowYamlV1Schema,
  formSchemaSchema,
  maisterYamlV2Schema,
  type CapabilityAgent,
  type CapabilityKind,
  type FlowYamlV1,
  type MaisterYamlV2,
  type McpCapabilityConfig,
  type NodeDef,
} from "@/lib/config.schema";
import { MaisterError } from "@/lib/errors";
import {
  GRAPH_MIN_ENGINE_VERSION,
  declaresGraphCapableEngineMin,
} from "@/lib/flows/engine-version";

const log = pino({ name: "config" });

const platformMcpJsonSchema = z.object({
  mcpServers: z.record(
    z.string().min(1),
    z.object({
      command: z.string().min(1),
      args: z.array(z.string()).optional(),
      env: z.record(z.string(), z.string()).optional(),
      disabled: z.boolean().optional(),
    }),
  ),
});

function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

export async function loadProjectConfig(
  maisterYamlPath: string,
): Promise<MaisterYamlV2> {
  let raw: string;

  try {
    raw = await readFile(maisterYamlPath, "utf8");
  } catch (err) {
    throw new MaisterError(
      "CONFIG",
      `Cannot read maister.yaml at ${maisterYamlPath}: ${asError(err).message}`,
      { cause: asError(err) },
    );
  }

  let data: unknown;

  try {
    data = parseYaml(raw);
  } catch (err) {
    throw new MaisterError(
      "CONFIG",
      `Invalid YAML in ${maisterYamlPath}: ${asError(err).message}`,
      { cause: asError(err) },
    );
  }

  const parsed = maisterYamlV2Schema.safeParse(data);

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");

    log.warn(
      { path: maisterYamlPath, issues },
      "maister.yaml validation failed",
    );
    throw new MaisterError(
      "CONFIG",
      `maister.yaml schema errors in ${maisterYamlPath}: ${issues}`,
    );
  }

  const cfg = parsed.data;

  log.debug(
    {
      path: maisterYamlPath,
      executors: cfg.executors.length,
      flows: cfg.flows.length,
    },
    "maister.yaml loaded",
  );

  const executorIds = new Set<string>();

  for (const ex of cfg.executors) {
    if (executorIds.has(ex.id)) {
      throw new MaisterError(
        "CONFIG",
        `Duplicate executor id "${ex.id}" in ${maisterYamlPath}`,
      );
    }
    executorIds.add(ex.id);
  }

  if (!executorIds.has(cfg.default_executor)) {
    throw new MaisterError(
      "CONFIG",
      `default_executor "${cfg.default_executor}" not found in executors[] of ${maisterYamlPath}`,
    );
  }

  const flowIds = new Set<string>();

  for (const f of cfg.flows) {
    if (flowIds.has(f.id)) {
      throw new MaisterError(
        "CONFIG",
        `Duplicate flow id "${f.id}" in ${maisterYamlPath}`,
      );
    }
    flowIds.add(f.id);

    if (f.executor_override && !executorIds.has(f.executor_override)) {
      throw new MaisterError(
        "CONFIG",
        `Flow "${f.id}" executor_override "${f.executor_override}" not found in executors[] of ${maisterYamlPath}`,
      );
    }
  }

  validateCapabilityIds(cfg, maisterYamlPath);

  return cfg;
}

function validateCapabilityIds(
  cfg: MaisterYamlV2,
  maisterYamlPath: string,
): void {
  const seen = new Set<string>();
  const groups: ReadonlyArray<
    readonly [CapabilityKind, readonly { id: string }[]]
  > = [
    ["mcp", cfg.capabilities.mcps],
    ["skill", cfg.capabilities.skills],
    ["rule", cfg.capabilities.rules],
    ["restriction", cfg.capabilities.restrictions],
    ["setting", cfg.capabilities.settings],
    ["tool", cfg.capabilities.tools],
  ];

  for (const [kind, entries] of groups) {
    for (const entry of entries) {
      const key = `${kind}:${entry.id}`;

      if (seen.has(key)) {
        throw new MaisterError(
          "CONFIG",
          `Duplicate capability id "${entry.id}" in ${kind}s of ${maisterYamlPath}`,
        );
      }
      seen.add(key);
    }
  }

  log.debug(
    {
      path: maisterYamlPath,
      capabilities: Object.fromEntries(
        groups.map(([kind, entries]) => [kind, entries.length]),
      ),
    },
    "maister.yaml capabilities parsed",
  );
}

export async function loadPlatformMcpCapabilities(
  mcpJsonPath: string,
): Promise<Array<McpCapabilityConfig & { source: "platform" }>> {
  let raw: string;

  try {
    raw = await readFile(mcpJsonPath, "utf8");
  } catch (err) {
    throw new MaisterError(
      "CONFIG",
      `Cannot read MCP registry at ${mcpJsonPath}: ${asError(err).message}`,
      { cause: asError(err) },
    );
  }

  let data: unknown;

  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new MaisterError(
      "CONFIG",
      `Invalid JSON in ${mcpJsonPath}: ${asError(err).message}`,
      { cause: asError(err) },
    );
  }

  const parsed = platformMcpJsonSchema.safeParse(data);

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");

    log.warn({ path: mcpJsonPath, issues }, "MCP registry validation failed");
    throw new MaisterError(
      "CONFIG",
      `MCP registry schema errors in ${mcpJsonPath}: ${issues}`,
    );
  }

  const defaultAgents: CapabilityAgent[] = ["claude", "codex"];
  const capabilities = Object.entries(parsed.data.mcpServers)
    .filter(([, server]) => server.disabled !== true)
    .map(([id, server]) => ({
      id,
      kind: "mcp" as const,
      label: id,
      source: "platform" as const,
      command: server.command,
      args: server.args ?? [],
      env: server.env,
      agents: defaultAgents,
      enforceability: "enforced" as const,
      selected_by_default: true,
    }));

  log.debug(
    { path: mcpJsonPath, mcpCount: capabilities.length },
    "platform MCP registry loaded",
  );

  return capabilities;
}

export async function loadFlowManifest(
  flowYamlPath: string,
  opts?: { executorIds?: readonly string[] | ReadonlySet<string> },
): Promise<FlowYamlV1> {
  let raw: string;

  try {
    raw = await readFile(flowYamlPath, "utf8");
  } catch (err) {
    throw new MaisterError(
      "CONFIG",
      `Cannot read flow.yaml at ${flowYamlPath}: ${asError(err).message}`,
      { cause: asError(err) },
    );
  }

  let data: unknown;

  try {
    data = parseYaml(raw);
  } catch (err) {
    throw new MaisterError(
      "CONFIG",
      `Invalid YAML in ${flowYamlPath}: ${asError(err).message}`,
      { cause: asError(err) },
    );
  }

  const parsed = flowYamlV1Schema.safeParse(data);

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");

    log.warn({ path: flowYamlPath, issues }, "flow.yaml validation failed");
    throw new MaisterError(
      "CONFIG",
      `flow.yaml schema errors in ${flowYamlPath}: ${issues}`,
    );
  }

  const manifest = parsed.data;

  // M11a graph manifest (`nodes[]`): validate the graph, then return.
  if (manifest.nodes) {
    validateGraphManifest(manifest, manifest.nodes, flowYamlPath, opts);

    return manifest;
  }

  // Linear `steps[]` manifest (legacy path). `steps` is guaranteed present here
  // by the exactly-one `.refine` in flowYamlV1Schema.
  const steps = manifest.steps ?? [];

  log.debug(
    {
      path: flowYamlPath,
      steps: steps.length,
      contract: {
        compat: manifest.compat,
        capabilities: manifest.capabilities?.length ?? 0,
        gates: manifest.gates?.length ?? 0,
        artifacts: manifest.artifacts?.length ?? 0,
        externalOps: manifest.external_ops?.length ?? 0,
      },
    },
    "flow.yaml loaded",
  );

  const stepIds = new Set<string>();

  for (const s of steps) {
    if (stepIds.has(s.id)) {
      throw new MaisterError(
        "CONFIG",
        `Duplicate step id "${s.id}" in ${flowYamlPath}`,
      );
    }
    stepIds.add(s.id);
  }

  for (const s of steps) {
    if (s.type === "human" && s.on_reject?.goto_step) {
      if (!stepIds.has(s.on_reject.goto_step)) {
        throw new MaisterError(
          "CONFIG",
          `Step "${s.id}" on_reject.goto_step "${s.on_reject.goto_step}" not found in steps[] of ${flowYamlPath}`,
        );
      }
    }
  }

  for (const s of steps) {
    let template: string | undefined;

    if (s.type === "agent") template = s.prompt;
    else if (s.type === "cli") template = s.command;

    if (template === undefined) continue;

    try {
      Mustache.parse(template);
      log.debug(
        { path: flowYamlPath, stepId: s.id, type: s.type },
        "template parse-ok",
      );
    } catch (err) {
      throw new MaisterError(
        "CONFIG",
        `flow.yaml step ${s.id}: invalid mustache template — ${asError(err).message}`,
        { cause: asError(err) },
      );
    }
  }

  return manifest;
}

function nodeActionTemplate(node: NodeDef): string | undefined {
  if (node.type === "ai_coding" || node.type === "judge") {
    return node.action.prompt;
  }
  if (node.type === "cli" || node.type === "check") {
    return node.action.command;
  }

  return undefined;
}

// Detects a cycle in the transition graph that is NOT bounded by a `rework`
// block. A cycle is "safe" only if at least one node on it declares `rework`
// (which forces a `maxLoops`). Returns the offending cycle node-id path, or
// null when every cycle is bounded (ADR-026 / AC-2).
function findUnboundedCycle(nodes: NodeDef[]): string[] | null {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const adj = new Map<string, string[]>();

  for (const n of nodes) {
    adj.set(n.id, Object.values(n.transitions ?? {}));
  }

  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>(nodes.map((n) => [n.id, WHITE]));
  const stack: string[] = [];

  function dfs(id: string): string[] | null {
    color.set(id, GRAY);
    stack.push(id);

    for (const next of adj.get(id) ?? []) {
      const c = color.get(next);

      if (c === GRAY) {
        // Back-edge -> cycle from `next` to the top of the stack.
        const cycle = stack.slice(stack.indexOf(next));
        const bounded = cycle.some(
          (cid) => byId.get(cid)?.rework !== undefined,
        );

        if (!bounded) return [...cycle, next];
      } else if (c === WHITE) {
        const found = dfs(next);

        if (found) return found;
      }
    }

    stack.pop();
    color.set(id, BLACK);

    return null;
  }

  for (const n of nodes) {
    if (color.get(n.id) === WHITE) {
      const found = dfs(n.id);

      if (found) return found;
    }
  }

  return null;
}

// Cross-reference + cycle + engine validation for a graph (`nodes[]`) manifest
// (ADR-026). zod has already validated node/gate shape; this enforces the
// graph-level invariants that zod cannot express.
function validateGraphManifest(
  manifest: FlowYamlV1,
  nodes: NodeDef[],
  flowYamlPath: string,
  opts?: { executorIds?: readonly string[] | ReadonlySet<string> },
): void {
  // Graph flows must declare a sufficient engine_min.
  if (!declaresGraphCapableEngineMin(manifest.compat?.engine_min)) {
    throw new MaisterError(
      "CONFIG",
      `graph flow ${flowYamlPath} must declare compat.engine_min >= ${GRAPH_MIN_ENGINE_VERSION} (got ${
        manifest.compat?.engine_min ?? "unset"
      })`,
    );
  }

  const nodeIds = new Set<string>();

  for (const n of nodes) {
    if (n.id === TERMINAL_TRANSITION_TARGET) {
      throw new MaisterError(
        "CONFIG",
        `node id "${TERMINAL_TRANSITION_TARGET}" is reserved as the terminal transition target in ${flowYamlPath}`,
      );
    }
    if (nodeIds.has(n.id)) {
      throw new MaisterError(
        "CONFIG",
        `Duplicate node id "${n.id}" in ${flowYamlPath}`,
      );
    }
    nodeIds.add(n.id);
  }

  const refUnknown = (where: string, id: string): never => {
    throw new MaisterError(
      "CONFIG",
      `${where} references unknown node id "${id}" in ${flowYamlPath}`,
    );
  };

  const executorIds =
    opts?.executorIds === undefined
      ? undefined
      : opts.executorIds instanceof Set
        ? opts.executorIds
        : new Set(opts.executorIds);

  const gateIds = new Set<string>();
  let settingsNodeCount = 0;
  const enforcementTally: Record<string, number> = {};

  for (const n of nodes) {
    if (n.settings) {
      settingsNodeCount += 1;
      validateNodeSettings(n, flowYamlPath, executorIds, enforcementTally);
    }

    for (const g of n.pre_finish?.gates ?? []) {
      if (gateIds.has(g.id)) {
        throw new MaisterError(
          "CONFIG",
          `Duplicate gate id "${g.id}" in ${flowYamlPath}`,
        );
      }
      gateIds.add(g.id);

      for (const sf of g.staleFrom ?? []) {
        if (!nodeIds.has(sf)) refUnknown(`gate "${g.id}" staleFrom`, sf);
      }
    }

    for (const [decision, target] of Object.entries(n.transitions ?? {})) {
      if (target === TERMINAL_TRANSITION_TARGET) continue;
      if (!nodeIds.has(target)) {
        refUnknown(`node "${n.id}" transition "${decision}"`, target);
      }
    }

    for (const decision of n.finish?.human?.decisions ?? []) {
      // Object.hasOwn (not `in`) so a decision literally named `toString` /
      // `constructor` / `valueOf` cannot pass via an inherited prototype key.
      if (!n.transitions || !Object.hasOwn(n.transitions, decision)) {
        throw new MaisterError(
          "CONFIG",
          `node "${n.id}" human decision "${decision}" has no declared transition in ${flowYamlPath}`,
        );
      }
    }

    for (const t of n.rework?.allowedTargets ?? []) {
      if (!nodeIds.has(t))
        refUnknown(`node "${n.id}" rework.allowedTargets`, t);
    }

    for (const req of n.input?.requires ?? []) {
      // Only `steps.<id>.…` templating refs name a node and are checked here.
      // A bare string (e.g. "plan-summary") is a typed-artifact name, validated
      // by the M12 artifact graph — not a node id — so it is intentionally not
      // checked against nodeIds in M11a.
      if (typeof req !== "string") continue;
      const m = /^steps\.([^.]+)\./.exec(req);

      if (m && !nodeIds.has(m[1])) {
        refUnknown(`node "${n.id}" input.requires`, m[1]);
      }
    }

    const template = nodeActionTemplate(n);

    if (template !== undefined) {
      try {
        Mustache.parse(template);
      } catch (err) {
        throw new MaisterError(
          "CONFIG",
          `flow.yaml node ${n.id}: invalid mustache template — ${asError(err).message}`,
          { cause: asError(err) },
        );
      }
    }
  }

  const unbounded = findUnboundedCycle(nodes);

  if (unbounded) {
    throw new MaisterError(
      "CONFIG",
      `graph flow ${flowYamlPath} has an unbounded cycle (${unbounded.join(
        " -> ",
      )}); a node on the cycle must declare rework.maxLoops`,
    );
  }

  log.info(
    {
      path: flowYamlPath,
      nodes: nodes.length,
      gates: gateIds.size,
      settingsNodes: settingsNodeCount,
      enforcementTally,
    },
    "flow.yaml graph manifest loaded",
  );
}

// M11c node-level settings validation (ADR-031/032). zod has already validated
// the typed settings shape per node type; this enforces the intra-manifest /
// server-state cross-references zod cannot express: executor refs (against the
// project's executors[] set when provided), human decisions (against the node's
// declared transitions). Capability-registry ref resolution is M14 (carve b).
function validateNodeSettings(
  n: NodeDef,
  flowYamlPath: string,
  executorIds: ReadonlySet<string> | undefined,
  enforcementTally: Record<string, number>,
): void {
  if (executorIds && n.type === "ai_coding") {
    for (const id of n.settings?.executors ?? []) {
      if (!executorIds.has(id)) {
        throw new MaisterError(
          "CONFIG",
          `node "${n.id}" settings.executors references unknown executor id "${id}" in ${flowYamlPath}`,
        );
      }
    }
  }

  if (n.type === "human") {
    for (const decision of n.settings?.decisions ?? []) {
      if (!Object.hasOwn(n.transitions ?? {}, decision)) {
        throw new MaisterError(
          "CONFIG",
          `node "${n.id}" settings.decisions entry "${decision}" has no matching transition in ${flowYamlPath}`,
        );
      }
    }
  }

  if (
    (n.type === "ai_coding" || n.type === "judge") &&
    n.settings?.enforcement
  ) {
    enforcementTally[n.id] = Object.keys(n.settings.enforcement).length;
  }
}

export function validateFormSchemaVersion(
  formSchema: unknown,
  expectedVersion: number,
): void {
  const parsed = formSchemaSchema.safeParse(formSchema);

  if (!parsed.success) {
    throw new MaisterError(
      "CONFIG",
      `Invalid form_schema: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
    );
  }

  if (parsed.data.schemaVersion !== expectedVersion) {
    throw new MaisterError(
      "CONFIG",
      `form_schema version mismatch: expected ${expectedVersion}, got ${parsed.data.schemaVersion}`,
    );
  }
}
