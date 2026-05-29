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
    ),
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

export const flowYamlV1Schema = z.object({
  schemaVersion: z.literal(1),
  name: z.string().min(1),
  recommended_executor: z.string().min(1).optional(),
  setup: z.string().min(1).optional(),
  steps: z.array(stepSchema).min(1),
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
export type Step = z.infer<typeof stepSchema>;
export type FormSchema = z.infer<typeof formSchemaSchema>;
