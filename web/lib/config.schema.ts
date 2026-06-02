import { z } from "zod";

export const executorSchema = z.object({
  id: z.string().min(1),
  agent: z.enum(["claude", "codex"]),
  model: z.string().min(1),
  env: z.record(z.string(), z.string()).optional(),
  router: z.enum(["ccr"]).optional(),
});

export const flowEntrySchema = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  version: z.string().min(1),
  executor_override: z.string().min(1).optional(),
});

export const flowRoleSchema = z.object({
  ref: z
    .string()
    .min(1)
    .regex(/^[A-Za-z0-9._-]+$/, "role ref must match /^[A-Za-z0-9._-]+$/"),
  label: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
});

export const capabilityAgentSchema = z.enum(["claude", "codex"]);

export const capabilitySourceSchema = z.enum([
  "platform",
  "project",
  "flow-package",
  "flow",
  "git",
  "local",
  "system",
]);

export const capabilityEnforceabilitySchema = z.enum([
  "enforced",
  "instructed",
  "unsupported",
]);

export const capabilityKindSchema = z.enum([
  "mcp",
  "skill",
  "rule",
  "setting",
  "restriction",
  "tool",
  "agent_definition",
  "env_profile",
]);

const capabilityAgentsSchema = z
  .union([
    z.array(capabilityAgentSchema).min(1),
    z.record(capabilityAgentSchema, z.string().min(1)),
  ])
  .default(["claude", "codex"]);

const capabilityCommonSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1).optional(),
  source: capabilitySourceSchema.default("project"),
  version: z.string().min(1).optional(),
  revision: z.string().min(1).optional(),
  agents: capabilityAgentsSchema,
  enforceability: capabilityEnforceabilitySchema.default("instructed"),
  selected_by_default: z.boolean().default(true),
});

export const mcpCapabilitySchema = capabilityCommonSchema.extend({
  kind: z.literal("mcp").default("mcp"),
  command: z.string().min(1).optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  enforceability: capabilityEnforceabilitySchema.default("enforced"),
});

export const skillCapabilitySchema = capabilityCommonSchema.extend({
  kind: z.literal("skill").default("skill"),
  url: z.string().min(1).optional(),
  path: z.string().min(1).optional(),
  content: z.string().min(1).optional(),
});

export const ruleCapabilitySchema = capabilityCommonSchema.extend({
  kind: z.literal("rule").default("rule"),
  path: z.string().min(1).optional(),
  content: z.string().min(1).optional(),
});

export const restrictionCapabilitySchema = capabilityCommonSchema.extend({
  kind: z.literal("restriction").default("restriction"),
  path: z.string().min(1).optional(),
  content: z.string().min(1).optional(),
});

export const settingCapabilitySchema = capabilityCommonSchema.extend({
  kind: z.literal("setting").default("setting"),
  agent: capabilityAgentSchema,
  path: z.string().min(1),
  enforceability: capabilityEnforceabilitySchema.default("enforced"),
});

export const toolCapabilitySchema = capabilityCommonSchema.extend({
  kind: z.literal("tool").default("tool"),
});

export const maisterCapabilitiesSchema = z
  .object({
    mcps: z.array(mcpCapabilitySchema).default([]),
    skills: z.array(skillCapabilitySchema).default([]),
    rules: z.array(ruleCapabilitySchema).default([]),
    restrictions: z.array(restrictionCapabilitySchema).default([]),
    settings: z.array(settingCapabilitySchema).default([]),
    tools: z.array(toolCapabilitySchema).default([]),
  })
  .default({});

export const projectBlockSchema = z.object({
  name: z.string().min(1),
  repo_path: z
    .string()
    .min(1)
    .refine(
      (p) => p.startsWith("/") && !p.split("/").includes(".."),
      "repo_path must be an absolute path with no '..' segment",
    )
    .optional(),
  main_branch: z.string().min(1).default("main"),
  branch_prefix: z.string().min(1).default("maister/"),
});

export const maisterYamlV2Schema = z.object({
  schemaVersion: z.literal(2),
  project: projectBlockSchema,
  executors: z.array(executorSchema).min(1),
  default_executor: z.string().min(1),
  capabilities: maisterCapabilitiesSchema,
  flow_roles: z.array(flowRoleSchema).default([]),
  flows: z.array(flowEntrySchema),
});

const guardConfigSchema = z
  .object({
    cost: z.number().optional(),
    time: z.number().optional(),
    regex: z.string().optional(),
  })
  .refine(
    (v) =>
      v.cost !== undefined || v.time !== undefined || v.regex !== undefined,
    {
      message: "guard step must declare at least one of cost/time/regex",
    },
  );

const cliStepSchema = z.object({
  id: z.string().min(1),
  type: z.literal("cli"),
  command: z.string().min(1),
  pre_guards: z.array(guardConfigSchema).optional(),
  post_guards: z.array(guardConfigSchema).optional(),
  // M19 crash-recover opt-in — see `nodeCommon.retry_safe`.
  retry_safe: z.boolean().optional(),
});

const agentStepSchema = z.object({
  id: z.string().min(1),
  type: z.literal("agent"),
  mode: z.enum(["new-session", "slash-in-existing"]),
  prompt: z.string().min(1),
  pre_guards: z.array(guardConfigSchema).optional(),
  post_guards: z.array(guardConfigSchema).optional(),
  retry_safe: z.boolean().optional(),
});

const guardStepSchema = z.object({
  id: z.string().min(1),
  type: z.literal("guard"),
  cost: z.number().optional(),
  time: z.number().optional(),
  regex: z.string().optional(),
  retry_safe: z.boolean().optional(),
});

const humanStepSchema = z.object({
  id: z.string().min(1),
  type: z.literal("human"),
  form_schema: z.string().min(1),
  on_reject: z
    .object({
      goto_step: z.string().min(1),
      comments_var: z.string().min(1).optional(),
    })
    .optional(),
  retry_safe: z.boolean().optional(),
});

export const stepSchema = z.discriminatedUnion("type", [
  cliStepSchema,
  agentStepSchema,
  guardStepSchema,
  humanStepSchema,
]);

// Engine/API compatibility range a Flow package declares. Enforced (engine +
// schemaVersion) at enablement in M10; see ADR-021.
export const flowCompatSchema = z.object({
  engine_min: z.string().min(1).optional(),
  engine_max: z.string().min(1).optional(),
});

// --- M12: typed artifact kinds (produces[]) — ADR-TBD --------------------
export const ARTIFACT_KINDS = [
  "diff",
  "log",
  "test_report",
  "lint_report",
  "ai_judgment",
  "human_note",
  "commit_set",
  "checkpoint",
  "preview",
  "generic_file",
] as const;

// --- M11a: Flow graph v1 (`nodes[]`) — ADR-026 ---------------------------
// A graph manifest declares `nodes[]` instead of `steps[]` (mutually
// exclusive). Cross-reference + cycle validation lives in `loadFlowManifest`
// (`config.ts`); zod here covers shape only.

// Reserved transition target meaning "the run is done" (reaches `Review`). A
// transition (e.g. `approve`) may point here instead of a node id; the runner
// treats it as terminal. Not a node — exempt from unknown-node-id validation.
export const TERMINAL_TRANSITION_TARGET = "done";

export const workspacePolicySchema = z.enum([
  "keep",
  "rewind-to-node-checkpoint",
  "fresh-attempt",
]);

const gateKindSchema = z.enum([
  "command_check",
  "skill_check",
  "ai_judgment",
  "artifact_required",
  "external_check",
  "human_review",
]);

export const gateSchema = z.object({
  id: z.string().min(1),
  kind: gateKindSchema,
  mode: z.enum(["blocking", "advisory"]).default("blocking"),
  command: z.string().min(1).optional(),
  prompt: z.string().min(1).optional(),
  skill: z.string().min(1).optional(),
  inputArtifacts: z.array(z.string().min(1)).optional(),
  output: z
    .object({ id: z.string().min(1), kind: z.string().min(1) })
    .passthrough()
    .optional(),
  // node ids whose rework marks this gate stale
  staleFrom: z.array(z.string().min(1)).optional(),
});

const nodeInputSchema = z
  .object({
    requires: z
      .array(
        z.union([
          z.string().min(1),
          z
            .object({ artifact: z.string().min(1), kind: z.string().min(1) })
            .passthrough(),
        ]),
      )
      .optional(),
  })
  .passthrough();

export const nodeOutputSchema = z
  .object({
    produces: z
      .array(
        z.object({
          id: z.string().min(1),
          kind: z.enum(ARTIFACT_KINDS),
          schema: z.string().min(1).optional(),
          path: z.string().optional(),
          ref: z.string().optional(),
          visibility: z.enum(["internal", "shared"]).optional(),
          retention: z.enum(["run", "ephemeral"]).optional(),
          requiredFor: z.array(z.enum(["review", "merge"])).optional(),
        }),
      )
      .optional(),
  })
  .passthrough();

export const humanDecisionSchema = z.string().min(1);

const finishHumanSchema = z.object({
  role: z.string().min(1).optional(),
  decisions: z.array(humanDecisionSchema).min(1),
  commentsVar: z.string().min(1).optional(),
});

const reworkSchema = z.object({
  allowedTargets: z.array(z.string().min(1)).min(1),
  workspacePolicies: z.array(workspacePolicySchema).min(1),
  maxLoops: z.number().int().positive(),
  commentsVar: z.string().min(1).optional(),
});

// --- M11c: typed per-node-type `settings` (replaces M11a opaque passthrough) ---
// ADR-031/032. Each node `type` carries a distinct, strict settings shape;
// unknown keys are rejected (M11a recorded them opaquely + WARNed). Capability-
// bearing settings (ai_coding/judge) also carry a per-class `enforcement` intent
// resolved at launch (M11c refusal boundary); enforcement defaults to `instruct`.

export const enforcementModeSchema = z.enum(["strict", "instruct", "off"]);

// Per-class enforcement INTENT. Kept SPARSE: only the classes the flow author
// explicitly set survive the parse, so the audit snapshot and run-detail panel
// never over-report intents the author never declared. The `instruct` default
// is applied at EVALUATION (evaluateNodeEnforcement) for a class declared by its
// data field with no explicit intent — NOT injected here as a per-key default
// (that would make every sparse map claim all six classes).
export const enforcementMapSchema = z
  .object({
    mcps: enforcementModeSchema.optional(),
    tools: enforcementModeSchema.optional(),
    skills: enforcementModeSchema.optional(),
    restrictions: enforcementModeSchema.optional(),
    permissionMode: enforcementModeSchema.optional(),
    workspaceAccess: enforcementModeSchema.optional(),
  })
  .strict();

const agentToolsSchema = z
  .object({
    claude: z.array(z.string().min(1)).optional(),
    codex: z.array(z.string().min(1)).optional(),
  })
  .strict();

const settingsLimitsSchema = z
  .object({
    maxDurationMinutes: z.number().positive().optional(),
    maxCostUsd: z.number().positive().optional(),
  })
  .strict();

const thinkingEffortSchema = z.enum(["low", "medium", "high"]);
const permissionModeSchema = z.enum(["ask", "allow", "deny"]);

export const aiCodingSettingsSchema = z
  .object({
    executors: z.array(z.string().min(1)).optional(),
    model: z.string().min(1).optional(),
    thinkingEffort: thinkingEffortSchema.optional(),
    mcps: z.array(z.string().min(1)).optional(),
    tools: agentToolsSchema.optional(),
    skills: z.array(z.string().min(1)).optional(),
    settingsProfile: z.string().min(1).optional(),
    workspaceAccess: z.enum(["read", "write", "none"]).optional(),
    artifactAccess: z.array(z.string().min(1)).optional(),
    permissionMode: permissionModeSchema.optional(),
    limits: settingsLimitsSchema.optional(),
    restrictions: z.array(z.string().min(1)).optional(),
    enforcement: enforcementMapSchema.optional(),
  })
  .strict();

export const judgeSettingsSchema = z
  .object({
    mcps: z.array(z.string().min(1)).optional(),
    tools: agentToolsSchema.optional(),
    skills: z.array(z.string().min(1)).optional(),
    restrictions: z.array(z.string().min(1)).optional(),
    permissionMode: permissionModeSchema.optional(),
    model: z.string().min(1).optional(),
    thinkingEffort: thinkingEffortSchema.optional(),
    limits: settingsLimitsSchema.optional(),
    enforcement: enforcementMapSchema.optional(),
  })
  .strict();

export const humanSettingsSchema = z
  .object({
    roles: z.array(z.string().min(1)).optional(),
    assignees: z.array(z.string().min(1)).optional(),
    decisions: z.array(z.string().min(1)).optional(),
    allowFurtherTracks: z.boolean().optional(),
    allowTakeover: z.boolean().optional(),
    slaHours: z.number().positive().optional(),
    stalenessHint: z.string().min(1).optional(),
    returnRequires: z.array(z.string().min(1)).optional(),
  })
  .strict();

export const cliCheckSettingsSchema = z
  .object({
    command: z.string().min(1).optional(),
    timeoutMs: z.number().positive().optional(),
    environmentPolicy: z.enum(["inherit", "clean", "whitelist"]).optional(),
    inputArtifacts: z.array(z.string().min(1)).optional(),
    outputArtifacts: z.array(z.string().min(1)).optional(),
    failureClass: z.enum(["blocking", "advisory", "retryable"]).optional(),
  })
  .strict();

// Fields common to every node type. `settings` is NOT here — it is typed per
// node-type member below (M11c).
const nodeCommon = {
  id: z.string().min(1),
  input: nodeInputSchema.optional(),
  output: nodeOutputSchema.optional(),
  pre_finish: z.object({ gates: z.array(gateSchema).optional() }).optional(),
  finish: z
    .object({ human: finishHumanSchema.optional() })
    .passthrough()
    .optional(),
  // decision/outcome -> target node id
  transitions: z.record(z.string(), z.string().min(1)).optional(),
  rework: reworkSchema.optional(),
  // M19 crash-recover (ADR-034): opt-in that lets an operator Recover re-dispatch
  // this node after a crash. Session-less nodes (cli/check/judge/guard/human)
  // have no `--resume` handle, so re-running them repeats their side effects;
  // recovery is offered ONLY when the Flow author marks the node retry-safe.
  // Default false → such a crashed node is discard-only. Ignored for `ai_coding`
  // (recovered via `--resume`, not re-dispatch).
  retry_safe: z.boolean().optional(),
};

const aiCodingNodeSchema = z.object({
  ...nodeCommon,
  type: z.literal("ai_coding"),
  action: z.object({ prompt: z.string().min(1) }).passthrough(),
  settings: aiCodingSettingsSchema.optional(),
});

const judgeNodeSchema = z.object({
  ...nodeCommon,
  type: z.literal("judge"),
  action: z.object({ prompt: z.string().min(1) }).passthrough(),
  settings: judgeSettingsSchema.optional(),
});

const cliNodeSchema = z.object({
  ...nodeCommon,
  type: z.literal("cli"),
  action: z.object({ command: z.string().min(1) }).passthrough(),
  settings: cliCheckSettingsSchema.optional(),
});

const checkNodeSchema = z.object({
  ...nodeCommon,
  type: z.literal("check"),
  action: z.object({ command: z.string().min(1) }).passthrough(),
  settings: cliCheckSettingsSchema.optional(),
});

const humanNodeSchema = z.object({
  ...nodeCommon,
  type: z.literal("human"),
  action: z.object({}).passthrough().optional(),
  settings: humanSettingsSchema.optional(),
});

export const nodeSchema = z.discriminatedUnion("type", [
  aiCodingNodeSchema,
  judgeNodeSchema,
  cliNodeSchema,
  checkNodeSchema,
  humanNodeSchema,
]);

export const flowYamlV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    name: z.string().min(1),
    recommended_executor: z.string().min(1).optional(),
    setup: z.string().min(1).optional(),
    // Package contract (M10): recorded + displayed as opaque metadata; only
    // `compat` and `schemaVersion` are enforced today. Semantic validation of
    // capabilities/gates/artifacts/external_ops lands with M11+ (see ADR-021).
    compat: flowCompatSchema.optional(),
    capabilities: z.array(z.string().min(1)).optional(),
    gates: z.array(z.string().min(1)).optional(),
    artifacts: z.array(z.string().min(1)).optional(),
    external_ops: z.array(z.string().min(1)).optional(),
    // Exactly one of `steps` (linear) or `nodes` (graph v1) is present —
    // enforced by the .refine below (ADR-026). `steps` was required before
    // M11a; it is now optional so the refine can reject both-absent.
    steps: z.array(stepSchema).min(1).optional(),
    nodes: z.array(nodeSchema).min(1).optional(),
  })
  .refine((d) => (d.steps ? 1 : 0) + (d.nodes ? 1 : 0) === 1, {
    message: "flow manifest must declare exactly one of steps[] or nodes[]",
  });

const formFieldSchema = z.object({
  name: z.string().min(1),
  label: z.string().min(1).optional(),
  type: z.enum(["string", "number", "boolean", "enum", "array"]),
  required: z.boolean().optional(),
  default: z.unknown().optional(),
  options: z.array(z.string()).optional(),
});

export const formSchemaSchema = z.object({
  schemaVersion: z.number().int().positive(),
  fields: z.array(formFieldSchema),
});

export type MaisterYamlV2 = z.infer<typeof maisterYamlV2Schema>;
export type ExecutorConfig = z.infer<typeof executorSchema>;
export type FlowEntry = z.infer<typeof flowEntrySchema>;
export type CapabilityAgent = z.infer<typeof capabilityAgentSchema>;
export type CapabilitySource = z.infer<typeof capabilitySourceSchema>;
export type CapabilityKind = z.infer<typeof capabilityKindSchema>;
export type CapabilityEnforceability = z.infer<
  typeof capabilityEnforceabilitySchema
>;
export type McpCapabilityConfig = z.infer<typeof mcpCapabilitySchema>;
export type SkillCapabilityConfig = z.infer<typeof skillCapabilitySchema>;
export type RuleCapabilityConfig = z.infer<typeof ruleCapabilitySchema>;
export type RestrictionCapabilityConfig = z.infer<
  typeof restrictionCapabilitySchema
>;
export type SettingCapabilityConfig = z.infer<typeof settingCapabilitySchema>;
export type ToolCapabilityConfig = z.infer<typeof toolCapabilitySchema>;
export type MaisterCapabilitiesConfig = z.infer<
  typeof maisterCapabilitiesSchema
>;
export type FlowYamlV1 = z.infer<typeof flowYamlV1Schema>;
export type FlowCompat = z.infer<typeof flowCompatSchema>;
export type Step = z.infer<typeof stepSchema>;
export type FormSchema = z.infer<typeof formSchemaSchema>;
export type NodeDef = z.infer<typeof nodeSchema>;
export type GateDef = z.infer<typeof gateSchema>;
export type WorkspacePolicy = z.infer<typeof workspacePolicySchema>;
export type HumanDecision = z.infer<typeof humanDecisionSchema>;
export type EnforcementMode = z.infer<typeof enforcementModeSchema>;
export type EnforcementMap = z.infer<typeof enforcementMapSchema>;
export type AiCodingSettings = z.infer<typeof aiCodingSettingsSchema>;
export type JudgeSettings = z.infer<typeof judgeSettingsSchema>;
export type HumanSettings = z.infer<typeof humanSettingsSchema>;
export type CliCheckSettings = z.infer<typeof cliCheckSettingsSchema>;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];
export type NodeOutput = z.infer<typeof nodeOutputSchema>;
