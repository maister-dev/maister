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
});

const agentStepSchema = z.object({
  id: z.string().min(1),
  type: z.literal("agent"),
  mode: z.enum(["new-session", "slash-in-existing"]),
  prompt: z.string().min(1),
  pre_guards: z.array(guardConfigSchema).optional(),
  post_guards: z.array(guardConfigSchema).optional(),
});

const guardStepSchema = z.object({
  id: z.string().min(1),
  type: z.literal("guard"),
  cost: z.number().optional(),
  time: z.number().optional(),
  regex: z.string().optional(),
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

const nodeOutputSchema = z
  .object({
    // Typed artifact instances are M12; recorded but not validated in M11a.
    produces: z
      .array(
        z
          .object({ id: z.string().min(1), kind: z.string().min(1) })
          .passthrough(),
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

// Fields common to every node type.
const nodeCommon = {
  id: z.string().min(1),
  input: nodeInputSchema.optional(),
  output: nodeOutputSchema.optional(),
  // M11c/M14 capability fields. In M11a `settings` is an OPAQUE PASSTHROUGH —
  // preserved (never stripped) but NOT enforced; `loadFlowManifest` emits
  // SETTINGS_NOT_ENFORCED_WARN. Typed validation + enforcement = M11c.
  settings: z.record(z.string(), z.unknown()).optional(),
  pre_finish: z.object({ gates: z.array(gateSchema).optional() }).optional(),
  finish: z
    .object({ human: finishHumanSchema.optional() })
    .passthrough()
    .optional(),
  // decision/outcome -> target node id
  transitions: z.record(z.string(), z.string().min(1)).optional(),
  rework: reworkSchema.optional(),
};

const aiCodingNodeSchema = z.object({
  ...nodeCommon,
  type: z.literal("ai_coding"),
  action: z.object({ prompt: z.string().min(1) }).passthrough(),
});

const judgeNodeSchema = z.object({
  ...nodeCommon,
  type: z.literal("judge"),
  action: z.object({ prompt: z.string().min(1) }).passthrough(),
});

const cliNodeSchema = z.object({
  ...nodeCommon,
  type: z.literal("cli"),
  action: z.object({ command: z.string().min(1) }).passthrough(),
});

const checkNodeSchema = z.object({
  ...nodeCommon,
  type: z.literal("check"),
  action: z.object({ command: z.string().min(1) }).passthrough(),
});

const humanNodeSchema = z.object({
  ...nodeCommon,
  type: z.literal("human"),
  action: z.object({}).passthrough().optional(),
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
export type FlowYamlV1 = z.infer<typeof flowYamlV1Schema>;
export type FlowCompat = z.infer<typeof flowCompatSchema>;
export type Step = z.infer<typeof stepSchema>;
export type FormSchema = z.infer<typeof formSchemaSchema>;
export type NodeDef = z.infer<typeof nodeSchema>;
export type GateDef = z.infer<typeof gateSchema>;
export type WorkspacePolicy = z.infer<typeof workspacePolicySchema>;
export type HumanDecision = z.infer<typeof humanDecisionSchema>;
