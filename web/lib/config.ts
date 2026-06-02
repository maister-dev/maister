import "server-only";

import { readFile } from "node:fs/promises";

import Mustache from "mustache";
import pino from "pino";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

import {
  ARTIFACT_KINDS,
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
  MAISTER_ENGINE_VERSION,
  declaresGraphCapableEngineMin,
  semverGte,
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
  validateFlowRoleRefs(cfg, maisterYamlPath);

  return cfg;
}

function validateFlowRoleRefs(
  cfg: MaisterYamlV2,
  maisterYamlPath: string,
): void {
  const seen = new Set<string>();

  for (const role of cfg.flow_roles) {
    if (seen.has(role.ref)) {
      throw new MaisterError(
        "CONFIG",
        `Duplicate flow role ref "${role.ref}" in ${maisterYamlPath}`,
      );
    }
    seen.add(role.ref);
  }
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
  opts?: {
    executorIds?: readonly string[] | ReadonlySet<string>;
    roleRefs?: readonly string[] | ReadonlySet<string>;
  },
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

// Artifact floor version: manifests that use typed artifacts must declare
// engine_min >= this value.
const ARTIFACT_ENGINE_MIN = "1.2.0";

// Returns true when the manifest uses any artifact feature (produces, artifact
// input.requires, or artifact_required gates). Used to gate the engine-min check.
function declaresArtifacts(nodes: NodeDef[]): boolean {
  for (const n of nodes) {
    if (n.output?.produces && n.output.produces.length > 0) return true;

    for (const req of n.input?.requires ?? []) {
      // bare non-steps.* string OR {artifact:...} object
      if (typeof req === "string") {
        if (!/^steps\./.test(req)) return true;
      } else {
        return true;
      }
    }

    for (const g of n.pre_finish?.gates ?? []) {
      if (g.kind === "artifact_required") return true;
    }
  }

  return false;
}

// Cross-reference + cycle + engine validation for a graph (`nodes[]`) manifest
// (ADR-026). zod has already validated node/gate shape; this enforces the
// graph-level invariants that zod cannot express.
function validateGraphManifest(
  manifest: FlowYamlV1,
  nodes: NodeDef[],
  flowYamlPath: string,
  opts?: {
    executorIds?: readonly string[] | ReadonlySet<string>;
    roleRefs?: readonly string[] | ReadonlySet<string>;
  },
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

  const engineMin = manifest.compat?.engine_min ?? "";
  const artifactsPresent = declaresArtifacts(nodes);

  // Engine gate: manifests declaring artifacts require engine_min >= 1.2.0.
  if (artifactsPresent && !semverGte(engineMin, ARTIFACT_ENGINE_MIN)) {
    throw new MaisterError(
      "CONFIG",
      `graph flow ${flowYamlPath} is declaring artifacts but engine_min "${engineMin}" < ${ARTIFACT_ENGINE_MIN} — bump compat.engine_min to ${ARTIFACT_ENGINE_MIN} (host engine is ${MAISTER_ENGINE_VERSION})`,
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
  const roleRefs =
    opts?.roleRefs === undefined
      ? undefined
      : opts.roleRefs instanceof Set
        ? opts.roleRefs
        : new Set(opts.roleRefs);

  const gateIds = new Set<string>();
  let settingsNodeCount = 0;
  const enforcementTally: Record<string, number> = {};

  // Artifact validation (rules 1-5) runs only when engine_min >= 1.2.0.
  // A no-artifacts graph at 1.1.0 is still valid (backward compat).
  if (semverGte(engineMin, ARTIFACT_ENGINE_MIN)) {
    validateArtifacts(nodes, flowYamlPath);
  }

  for (const n of nodes) {
    validateNodeRoleRefs(n, flowYamlPath, roleRefs);

    if (n.settings) {
      settingsNodeCount += 1;
      validateNodeSettings(
        n,
        flowYamlPath,
        executorIds,
        roleRefs,
        enforcementTally,
      );
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
      // steps.<id>.… refs name a node id and are validated against nodeIds.
      // Bare non-steps.* strings are typed-artifact names validated by
      // validateArtifacts (above, when engine_min >= 1.2.0). Object form
      // {artifact:...} is also handled there.
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

// Validates artifact-level invariants (rules 1-5, M12). Called only when
// engine_min >= 1.2.0 so backward-compat graphs are untouched.
function validateArtifacts(nodes: NodeDef[], flowYamlPath: string): void {
  const artifactKindSet = new Set<string>(ARTIFACT_KINDS);

  // Build registry of all produced artifact ids (rule 1: no duplicates) and a
  // map of id → produced kind (rule 2b: requires kind-mismatch check).
  const registry = new Set<string>();
  const registryKind = new Map<string, string>();

  for (const n of nodes) {
    for (const p of n.output?.produces ?? []) {
      // Rule 1: duplicate produces id across nodes.
      if (registry.has(p.id)) {
        throw new MaisterError(
          "CONFIG",
          `duplicate produces id "${p.id}" in ${flowYamlPath}`,
        );
      }
      registry.add(p.id);
      registryKind.set(p.id, p.kind);

      // Rule 3: belt-and-suspenders kind check beyond schema.
      if (!artifactKindSet.has(p.kind)) {
        throw new MaisterError(
          "CONFIG",
          `produces "${p.id}" has unsupported kind "${p.kind}" in ${flowYamlPath}`,
        );
      }

      // Rule 4: path must be a non-empty relative FILE path — no '..' segment,
      // no trailing slash, not "" or ".". An empty or dot path joins to the run
      // directory itself, which access() accepts; the payload route then 500s
      // trying to read a directory as a file.
      if (p.path !== undefined) {
        const isAbsolute = p.path.startsWith("/");
        const hasDotDot = p.path.split(/[/\\]/).includes("..");
        const isDirLike = /[/\\]$/.test(p.path);
        const normalized = p.path.replace(/\\/g, "/").replace(/\/+$/, "");
        const isEmptyOrDot = normalized === "" || normalized === ".";

        if (isAbsolute || hasDotDot || isDirLike || isEmptyOrDot) {
          throw new MaisterError(
            "CONFIG",
            `produces "${p.id}" path "${p.path}" must be a non-empty relative file path (no '..', no trailing slash) in ${flowYamlPath}`,
          );
        }
      }

      if (p.ref !== undefined && p.ref === "") {
        throw new MaisterError(
          "CONFIG",
          `produces "${p.id}" ref must not be empty in ${flowYamlPath}`,
        );
      }
    }
  }

  // Rule 2: input.requires artifact refs must be in the registry.
  for (const n of nodes) {
    for (const req of n.input?.requires ?? []) {
      if (typeof req === "string") {
        // steps.* refs are node-id refs handled elsewhere — skip here.
        if (/^steps\./.test(req)) continue;
        if (!registry.has(req)) {
          throw new MaisterError(
            "CONFIG",
            `node "${n.id}" input.requires references unknown artifact id "${req}" in ${flowYamlPath}`,
          );
        }
      } else {
        // Object form {artifact: id, kind: ...}
        if (!registry.has(req.artifact)) {
          throw new MaisterError(
            "CONFIG",
            `node "${n.id}" input.requires references unknown artifact id "${req.artifact}" in ${flowYamlPath}`,
          );
        }
        // Rule 2b: the declared kind MUST match the producing artifact's kind.
        const producedKind = registryKind.get(req.artifact);

        if (producedKind !== undefined && req.kind !== producedKind) {
          throw new MaisterError(
            "CONFIG",
            `node "${n.id}" input.requires "${req.artifact}" declares kind "${req.kind}" but it is produced as "${producedKind}" in ${flowYamlPath}`,
          );
        }
      }
    }
  }

  // Rule 5: artifact_required gates must reference artifacts in the registry.
  for (const n of nodes) {
    for (const g of n.pre_finish?.gates ?? []) {
      if (g.kind !== "artifact_required") continue;

      for (const artId of g.inputArtifacts ?? []) {
        if (!registry.has(artId)) {
          throw new MaisterError(
            "CONFIG",
            `artifact_required gate "${g.id}" inputArtifacts references unknown artifact id "${artId}" in ${flowYamlPath}`,
          );
        }
      }
    }
  }
}

// M11c node-level settings validation (ADR-031/032). zod has already validated
// the typed settings shape per node type; this enforces the intra-manifest /
// server-state cross-references zod cannot express: executor refs (against the
// project's executors[] set when provided), human decisions (against the node's
// declared transitions). Capability-registry ref resolution is M14 (carve b).
// Returns the first `settings.executors[]` ref id absent from the supplied
// project executor ref-id set, or null when every ref resolves. Shared by the
// manifest loader (parse-time, when a ref set is supplied) and the launch
// precondition (POST /api/runs), where it is the authoritative gate: a flow
// package is generic across projects, so `settings.executors` (maister.yaml
// executor *ref* ids) can only be resolved against a concrete project's
// executors[] at launch.
export function firstUnknownExecutorRef(
  settingsExecutors: readonly string[] | undefined,
  executorRefIds: ReadonlySet<string>,
): string | null {
  for (const id of settingsExecutors ?? []) {
    if (!executorRefIds.has(id)) return id;
  }

  return null;
}

function validateNodeSettings(
  n: NodeDef,
  flowYamlPath: string,
  executorIds: ReadonlySet<string> | undefined,
  roleRefs: ReadonlySet<string> | undefined,
  enforcementTally: Record<string, number>,
): void {
  if (executorIds && n.type === "ai_coding") {
    const unknownRef = firstUnknownExecutorRef(
      n.settings?.executors,
      executorIds,
    );

    if (unknownRef !== null) {
      throw new MaisterError(
        "CONFIG",
        `node "${n.id}" settings.executors references unknown executor id "${unknownRef}" in ${flowYamlPath}`,
      );
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

    validateSettingsRoleRefs(n, flowYamlPath, roleRefs);
  }

  if (
    (n.type === "ai_coding" || n.type === "judge") &&
    n.settings?.enforcement
  ) {
    enforcementTally[n.id] = Object.keys(n.settings.enforcement).length;
  }
}

function validateNodeRoleRefs(
  n: NodeDef,
  flowYamlPath: string,
  roleRefs: ReadonlySet<string> | undefined,
): void {
  const role = n.finish?.human?.role;

  if (roleRefs === undefined || role === undefined || roleRefs.has(role)) {
    return;
  }

  throw new MaisterError(
    "CONFIG",
    `node "${n.id}" finish.human.role references unknown Flow role "${role}" in ${flowYamlPath}`,
  );
}

function validateSettingsRoleRefs(
  n: NodeDef,
  flowYamlPath: string,
  roleRefs: ReadonlySet<string> | undefined,
): void {
  if (n.type !== "human") return;
  if (roleRefs === undefined) return;

  for (const role of n.settings?.roles ?? []) {
    if (roleRefs.has(role)) continue;

    throw new MaisterError(
      "CONFIG",
      `node "${n.id}" settings.roles references unknown Flow role "${role}" in ${flowYamlPath}`,
    );
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
