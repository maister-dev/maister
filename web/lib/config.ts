import "server-only";

import { readFile, realpath } from "node:fs/promises";
import path from "node:path";

import Mustache from "mustache";
import pino from "pino";
import { parse as parseYaml } from "yaml";

import {
  ARTIFACT_KINDS,
  TERMINAL_TRANSITION_TARGET,
  allNodeMcpRefs,
  flowYamlV1Schema,
  formSchemaSchema,
  maisterYamlV2Schema,
  type CapabilityKind,
  type FlowYamlV1,
  type FormSchema,
  type MaisterYamlV2,
  type NodeDef,
  type NodeMcpsConfig,
} from "@/lib/config.schema";
import { MaisterError } from "@/lib/errors";
import {
  GRAPH_MIN_ENGINE_VERSION,
  MAISTER_ENGINE_VERSION,
  declaresGraphCapableEngineMin,
  semverGte,
} from "@/lib/flows/engine-version";

const log = pino({ name: "config" });

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
      flows: cfg.flows.length,
      defaultRunner: cfg.project.default_runner ?? null,
    },
    "maister.yaml loaded",
  );

  const flowIds = new Set<string>();

  for (const f of cfg.flows) {
    if (flowIds.has(f.id)) {
      throw new MaisterError(
        "CONFIG",
        `Duplicate flow id "${f.id}" in ${maisterYamlPath}`,
      );
    }
    flowIds.add(f.id);
  }

  const importIds = new Set<string>();

  for (const imp of cfg.capability_imports) {
    if (importIds.has(imp.id)) {
      throw new MaisterError(
        "CONFIG",
        `Duplicate capability_imports id "${imp.id}" in ${maisterYamlPath}`,
      );
    }
    importIds.add(imp.id);
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
    ["agent_definition", cfg.capabilities.agent_definitions],
    ["env_profile", cfg.capabilities.env_profiles],
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

/**
 * Build a CapabilityRefIdSets map from a parsed MaisterYamlV2 capabilities
 * block plus its capability_imports[]. Used at parse-time (loadProjectConfig)
 * and launch-time (POST /api/runs) to enforce node
 * settings.mcps/skills/restrictions/settingsProfile refs.
 *
 * A `capability_imports[]` entry is an opaque git-pinned package — there is no
 * manifest parsing yet (T2.2 stores `manifest: {}`), so the package's kind is
 * unknown at this layer. An import id therefore satisfies a node ref of ANY
 * kind: it is folded into every bucket. The catalog ingests it as a concrete
 * `agent_definition` capability_record (see installAndIngestCapabilityImports).
 */
export function buildCapabilityRefIds(cfg: MaisterYamlV2): CapabilityRefIdSets {
  const importIds = cfg.capability_imports.map((i) => i.id);

  return {
    mcp: new Set([...cfg.capabilities.mcps.map((c) => c.id), ...importIds]),
    skill: new Set([...cfg.capabilities.skills.map((c) => c.id), ...importIds]),
    restriction: new Set([
      ...cfg.capabilities.restrictions.map((c) => c.id),
      ...importIds,
    ]),
    setting: new Set([
      ...cfg.capabilities.settings.map((c) => c.id),
      ...importIds,
    ]),
  };
}

// A capability_records row reduced to the fields needed to rebuild the ref-id
// registry at launch time (when maister.yaml is not re-read from disk).
export type CapabilityRefRecord = {
  capabilityRefId: string;
  kind: CapabilityKind;
  source: string;
};

/**
 * Build the CapabilityRefIdSets registry from hydrated `capability_records`
 * rows. This is the launch-time (DB-backed) mirror of buildCapabilityRefIds:
 * the launch gate cannot re-read maister.yaml (the path may be absent), so it
 * derives the same registry from the catalog the register flow upserted.
 *
 * Bucketing matches buildCapabilityRefIds exactly:
 *  - mcp/skill/restriction/setting records land in their own bucket;
 *  - an import (ingested as kind `agent_definition`, source `flow-package`) is
 *    an opaque package and lands in EVERY bucket, so it can back a node ref of
 *    any kind (see buildCapabilityRefIds + installAndIngestCapabilityImports).
 * Callers pass only non-disabled rows (disabled_at IS NULL) so a CLEARed
 * capability (R-SYM) no longer resolves.
 */
export function capabilityRefIdSetsFromRecords(
  rows: readonly CapabilityRefRecord[],
): CapabilityRefIdSets {
  const mcp = new Set<string>();
  const skill = new Set<string>();
  const restriction = new Set<string>();
  const setting = new Set<string>();

  for (const r of rows) {
    if (r.kind === "mcp") mcp.add(r.capabilityRefId);
    else if (r.kind === "skill") skill.add(r.capabilityRefId);
    else if (r.kind === "restriction") restriction.add(r.capabilityRefId);
    else if (r.kind === "setting") setting.add(r.capabilityRefId);
    else if (r.kind === "agent_definition" && r.source === "flow-package") {
      mcp.add(r.capabilityRefId);
      skill.add(r.capabilityRefId);
      restriction.add(r.capabilityRefId);
      setting.add(r.capabilityRefId);
    }
  }

  return { mcp, skill, restriction, setting };
}

/**
 * First node-settings capability ref absent from the registry, or null when
 * every ref resolves. Shared by the manifest loader (validateNodeSettings,
 * parse/install-time) and the launch precondition (POST /api/runs) so the two
 * gates agree on what "unknown ref" means (R-CONTRACT). `settingsProfile` is an
 * ai_coding-only field.
 */
export function firstUnknownCapabilityRef(
  nodeType: "ai_coding" | "judge",
  settings:
    | {
        mcps?: NodeMcpsConfig;
        skills?: readonly string[];
        restrictions?: readonly string[];
        settingsProfile?: string;
      }
    | undefined,
  capabilityRefIds: CapabilityRefIdSets,
): { kind: "mcp" | "skill" | "restriction" | "setting"; ref: string } | null {
  // T-C6: validate BOTH required and additional MCP refs (normalized union).
  for (const ref of allNodeMcpRefs(settings?.mcps)) {
    if (!capabilityRefIds.mcp.has(ref)) return { kind: "mcp", ref };
  }

  for (const ref of settings?.skills ?? []) {
    if (!capabilityRefIds.skill.has(ref)) return { kind: "skill", ref };
  }

  for (const ref of settings?.restrictions ?? []) {
    if (!capabilityRefIds.restriction.has(ref)) {
      return { kind: "restriction", ref };
    }
  }

  if (nodeType === "ai_coding") {
    const profile = settings?.settingsProfile;

    if (profile !== undefined && !capabilityRefIds.setting.has(profile)) {
      return { kind: "setting", ref: profile };
    }
  }

  return null;
}

/**
 * First flow-package-declared MCP ref (manifest top-level `mcps`) absent from
 * the project mcp registry, or null when every ref resolves. Shared by the
 * hard-gate (validateGraphManifest) and the launch precondition (POST
 * /api/runs) so both gates agree on "unknown package mcp ref" (R-CONTRACT,
 * mirrors firstUnknownCapabilityRef). M27/T-C6 (C6-top, ADR-070).
 */
export function firstUnknownPackageMcpRef(
  packageMcps: readonly string[] | undefined,
  mcpRefIds: ReadonlySet<string>,
): string | null {
  for (const ref of packageMcps ?? []) {
    if (!mcpRefIds.has(ref)) return ref;
  }

  return null;
}

export type CapabilityRefIdsInput = {
  mcp?: readonly string[] | ReadonlySet<string>;
  skill?: readonly string[] | ReadonlySet<string>;
  restriction?: readonly string[] | ReadonlySet<string>;
  setting?: readonly string[] | ReadonlySet<string>;
};

export type CapabilityRefIdSets = {
  mcp: ReadonlySet<string>;
  skill: ReadonlySet<string>;
  restriction: ReadonlySet<string>;
  setting: ReadonlySet<string>;
};

function toCapabilityRefIdSets(
  input: CapabilityRefIdsInput,
): CapabilityRefIdSets {
  const toSet = (v: readonly string[] | ReadonlySet<string> | undefined) =>
    v instanceof Set ? v : new Set(v ?? []);

  return {
    mcp: toSet(input.mcp),
    skill: toSet(input.skill),
    restriction: toSet(input.restriction),
    setting: toSet(input.setting),
  };
}

export async function loadFlowManifest(
  flowYamlPath: string,
  opts?: {
    roleRefs?: readonly string[] | ReadonlySet<string>;
    capabilityRefIds?: CapabilityRefIdsInput;
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
    const capabilityRefIdSets =
      opts?.capabilityRefIds !== undefined
        ? toCapabilityRefIdSets(opts.capabilityRefIds)
        : undefined;

    validateGraphManifest(manifest, manifest.nodes, flowYamlPath, {
      roleRefs: opts?.roleRefs,
      capabilityRefIds: capabilityRefIdSets,
    });

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

// Structured-output floor version (M26): manifests with any node declaring
// `output.result` must declare engine_min >= this value.
const OUTPUT_ENGINE_MIN = "1.3.0";

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

// Returns true when any node declares the M26 structured-output channel
// (`output.result`). Used to gate the engine-min check.
function declaresOutputResult(nodes: NodeDef[]): boolean {
  for (const n of nodes) {
    if (n.output?.result) return true;
  }

  return false;
}

// Returns true when any gate declares M29 mutation features (must_touch /
// must_not_touch assertions or a mutation_report output kind). Shares the
// OUTPUT_ENGINE_MIN floor — D-C6/ADR-073: no version bump, broader trigger.
function declaresMutationAssertions(nodes: NodeDef[]): boolean {
  for (const n of nodes) {
    for (const g of n.pre_finish?.gates ?? []) {
      if (g.must_touch !== undefined || g.must_not_touch !== undefined) {
        return true;
      }
      if (g.output?.kind === "mutation_report") return true;
    }
  }

  return false;
}

// Cross-reference + cycle + engine validation for a graph (`nodes[]`) manifest
// (ADR-026). zod has already validated node/gate shape; this enforces the
// graph-level invariants that zod cannot express.
export function validateGraphManifest(
  manifest: FlowYamlV1,
  nodes: NodeDef[],
  flowYamlPath: string,
  opts?: {
    roleRefs?: readonly string[] | ReadonlySet<string>;
    capabilityRefIds?: CapabilityRefIdSets;
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

  // Engine gate (M26): manifests declaring `output.result` require
  // engine_min >= 1.3.0. Manifests without it stay valid at any engine_min.
  if (declaresOutputResult(nodes) && !semverGte(engineMin, OUTPUT_ENGINE_MIN)) {
    throw new MaisterError(
      "CONFIG",
      `graph flow ${flowYamlPath} is declaring output.result but engine_min "${engineMin}" < ${OUTPUT_ENGINE_MIN} — bump compat.engine_min to ${OUTPUT_ENGINE_MIN} (host engine is ${MAISTER_ENGINE_VERSION})`,
    );
  }

  // Engine gate widened for M29 (ADR-073, D-C6 — NO version bump): mutation
  // assertions / mutation_report gate outputs reuse the SAME 1.3.0 floor.
  // Manifests without them stay valid at any engine_min.
  if (
    declaresMutationAssertions(nodes) &&
    !semverGte(engineMin, OUTPUT_ENGINE_MIN)
  ) {
    throw new MaisterError(
      "CONFIG",
      `graph flow ${flowYamlPath} is declaring mutation assertions (must_touch/must_not_touch or a mutation_report gate output) but engine_min "${engineMin}" < ${OUTPUT_ENGINE_MIN} — bump compat.engine_min to ${OUTPUT_ENGINE_MIN} (host engine is ${MAISTER_ENGINE_VERSION})`,
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

  // Rule 6 (M15): blocking human_review gates deadlock promotion — reject always.
  validateNoBlockingHumanReview(nodes, flowYamlPath);

  const capabilityRefIds = opts?.capabilityRefIds;

  // M27/T-C6 (C6-top): reject package-level required MCP refs (manifest
  // top-level `mcps`) absent from the project registry. Skipped when no
  // registry is supplied (back-compat callers with no project context).
  if (capabilityRefIds !== undefined) {
    const unknownPackageMcp = firstUnknownPackageMcpRef(
      manifest.mcps,
      capabilityRefIds.mcp,
    );

    if (unknownPackageMcp !== null) {
      throw new MaisterError(
        "CONFIG",
        `flow package declares unknown required mcp capability ref "${unknownPackageMcp}" in ${flowYamlPath}`,
      );
    }
  }

  for (const n of nodes) {
    validateNodeRoleRefs(n, flowYamlPath, roleRefs);

    if (n.settings) {
      settingsNodeCount += 1;
      validateNodeSettings(
        n,
        flowYamlPath,
        roleRefs,
        enforcementTally,
        capabilityRefIds,
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

// Rule 6: blocking human_review gates are rejected at manifest validation.
// A human_review gate always records as "skipped" by the executor, so a
// blocking human_review would permanently prevent promotion (deadlock).
// Advisory human_review is permitted.
function validateNoBlockingHumanReview(
  nodes: NodeDef[],
  flowYamlPath: string,
): void {
  for (const n of nodes) {
    for (const g of n.pre_finish?.gates ?? []) {
      if (g.kind === "human_review" && g.mode === "blocking") {
        throw new MaisterError(
          "CONFIG",
          `human_review gate "${g.id}" in node "${n.id}" must not be blocking — it would deadlock promotion; use mode: "advisory" in ${flowYamlPath}`,
        );
      }
    }
  }
}

// M11c node-level settings validation (ADR-031/032). zod has already validated
// the typed settings shape per node type; this enforces the intra-manifest /
// server-state cross-references zod cannot express: human decisions (against the
// node's declared transitions) and capability-registry refs (M14 carve b:
// settings.mcps/skills/restrictions/settingsProfile against the project
// registry when capabilityRefIds is supplied; wired into the real load path
// in M14 T2.4 once resolved capability_imports complete the registry).

function validateNodeSettings(
  n: NodeDef,
  flowYamlPath: string,
  roleRefs: ReadonlySet<string> | undefined,
  enforcementTally: Record<string, number>,
  capabilityRefIds?: CapabilityRefIdSets,
): void {
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

  // M14 carve-b: validate capability ref ids when the registry is provided.
  // When capabilityRefIds is undefined (back-compat callers with no project
  // context), skip the check entirely.
  if (capabilityRefIds === undefined) return;

  if (n.type === "ai_coding" || n.type === "judge") {
    const unknown = firstUnknownCapabilityRef(
      n.type,
      n.settings,
      capabilityRefIds,
    );

    if (unknown !== null) {
      throw new MaisterError(
        "CONFIG",
        `node "${n.id}" unknown ${unknown.kind} capability ref "${unknown.ref}" in ${flowYamlPath}`,
      );
    }
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

function parseFormSchemaDoc(data: unknown, contextLabel: string): FormSchema {
  const parsed = formSchemaSchema.safeParse(data);

  if (!parsed.success) {
    throw new MaisterError(
      "CONFIG",
      `${contextLabel}: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
    );
  }

  return parsed.data;
}

export function validateFormSchemaVersion(
  formSchema: unknown,
  expectedVersion: number,
): void {
  const parsed = parseFormSchemaDoc(formSchema, "Invalid form_schema");

  if (parsed.schemaVersion !== expectedVersion) {
    throw new MaisterError(
      "CONFIG",
      `form_schema version mismatch: expected ${expectedVersion}, got ${parsed.schemaVersion}`,
    );
  }
}

// M26 (ADR-063): the single form_schema document loader. Resolves a relative
// `./path` against the flow install dir, escape-guards, follows the symlink to
// its real path (Flow bundles are symlinked into the project, so the real path
// must be inside the install dir too), reads, JSON-parses, and validates the
// formSchemaSchema grammar. Both the HITL `form_schema` loader (runner-human)
// and the node `output.result.schema` resolver call this — one read+parse+
// validate procedure, four `CONFIG` failure modes (escape, ENOENT, bad JSON,
// bad shape).
export async function readAndValidateFormSchemaDoc(
  flowInstallPath: string,
  relPath: string,
): Promise<FormSchema> {
  const base = path.resolve(flowInstallPath);
  const joined = path.resolve(base, relPath);

  if (!joined.startsWith(base + path.sep)) {
    throw new MaisterError(
      "CONFIG",
      `form_schema path escapes flow install dir: ${relPath}`,
    );
  }

  let resolvedPath: string;

  try {
    resolvedPath = await realpath(joined);
  } catch (err) {
    throw new MaisterError(
      "CONFIG",
      `form_schema file not found: ${joined} (${asError(err).message})`,
      { cause: asError(err) },
    );
  }

  // Canonicalize the base too: on macOS the temp/install root may itself sit
  // behind a symlink (/var -> /private/var), so the post-symlink prefix check
  // must compare real paths on both sides or it would reject legitimate files.
  const canonicalBase = await realpath(base);

  if (
    resolvedPath !== canonicalBase &&
    !resolvedPath.startsWith(canonicalBase + path.sep)
  ) {
    throw new MaisterError(
      "CONFIG",
      `form_schema path escapes flow install dir: ${relPath}`,
    );
  }

  let raw: string;

  try {
    raw = await readFile(resolvedPath, "utf8");
  } catch (err) {
    throw new MaisterError(
      "CONFIG",
      `cannot read form_schema ${resolvedPath}: ${asError(err).message}`,
      { cause: asError(err) },
    );
  }

  let data: unknown;

  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new MaisterError(
      "CONFIG",
      `form_schema is not valid JSON (${resolvedPath}): ${asError(err).message}`,
      { cause: asError(err) },
    );
  }

  return parseFormSchemaDoc(data, `invalid form_schema (${resolvedPath})`);
}

export async function resolveOutputResultSchema(
  flowInstallPath: string,
  relPath: string,
): Promise<FormSchema> {
  return readAndValidateFormSchemaDoc(flowInstallPath, relPath);
}
