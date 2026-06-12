import { z } from "zod";

import { ADAPTER_IDS, PROVIDER_KINDS } from "@/lib/acp-runners/adapter-support";

// Replicated from flow-paths.ts to avoid pulling the `server-only` constraint
// (and its transitive MaisterError dep) into config.schema.ts, which must remain
// importable in any context (tests, client-adjacent shared modules).
const SAFE_PATH_SEGMENT = /^[A-Za-z0-9._-]+$/;

const notCapDotRef = (s: string): boolean =>
  s !== "." && s !== ".." && !s.includes("..");

// Safe identifier for capability ref ids — mirrors flowIdSchema from flow-paths.ts
// but with a wider max (128 chars) to accommodate longer capability names.
export const capabilityRefIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(SAFE_PATH_SEGMENT, "capabilityRefId must match /^[A-Za-z0-9._-]+$/")
  .refine(
    notCapDotRef,
    "capabilityRefId must not be '.', '..' or contain '..'",
  );

export const flowEntrySchema = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  version: z.string().min(1),
  runner: z.string().min(1).optional(),
  executor_override: z.never().optional(),
});

export const flowRoleSchema = z.object({
  ref: z
    .string()
    .min(1)
    .regex(/^[A-Za-z0-9._-]+$/, "role ref must match /^[A-Za-z0-9._-]+$/"),
  label: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
});

export const capabilityAgentSchema = z.enum(ADAPTER_IDS);

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
  .default([...ADAPTER_IDS]);

const capabilityCommonSchema = z.object({
  id: capabilityRefIdSchema,
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
  // M27/T-C4: transport. Absent ⇒ `stdio` (back-compat) — readers default via
  // `?? "stdio"`. `stdio` uses command/args/env; `sse`/`http` use url/headers.
  // Header/env values are NEVER stored — only the NAME keys reach
  // `capability_records.material`; values resolve supervisor-side.
  transport: z.enum(["stdio", "sse", "http"]).optional(),
  command: z.string().min(1).optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  url: z.string().url().optional(),
  headers: z.record(z.string(), z.string()).optional(),
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
  // M29 (ADR-074): machine-readable subset the mutation sensor can check
  // (`diff ∩ paths`). Free-text-only restrictions (no paths) are reported
  // `unmatchable`, never failed on. Capability config — no engine floor.
  paths: z.array(z.string().min(1)).optional(),
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

export const agentDefinitionCapabilitySchema = capabilityCommonSchema.extend({
  kind: z.literal("agent_definition").default("agent_definition"),
});

export const envProfileCapabilitySchema = capabilityCommonSchema.extend({
  kind: z.literal("env_profile").default("env_profile"),
  env: z.record(z.string(), z.string()).optional(),
});

export const maisterCapabilitiesSchema = z
  .object({
    mcps: z.array(mcpCapabilitySchema).default([]),
    skills: z.array(skillCapabilitySchema).default([]),
    rules: z.array(ruleCapabilitySchema).default([]),
    restrictions: z.array(restrictionCapabilitySchema).default([]),
    settings: z.array(settingCapabilitySchema).default([]),
    tools: z.array(toolCapabilitySchema).default([]),
    agent_definitions: z.array(agentDefinitionCapabilitySchema).default([]),
    env_profiles: z.array(envProfileCapabilitySchema).default([]),
  })
  .default({});

// M18 (§3.4): project-level promotion defaults materialized at registration.
// SPARSE — keys are `.optional()` with no per-key `.default()`; the
// `local_merge` default is folded at the launch-time resolver
// (resolvePromotionMode), not injected here, so an absent `mode` materializes
// to NULL on projects.promotion_mode (SET/CLEAR symmetry). `remote` is parsed
// now but consumed only in Phase 3 (PR mode).
export const projectPromotionSchema = z
  .object({
    mode: z.enum(["local_merge", "pull_request"]).optional(),
    remote: z.string().min(1).optional(),
  })
  .strict();

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
  promotion: projectPromotionSchema.optional(),
  default_runner: z.string().min(1).optional(),
});

// A git-pinned capability package declared in `maister.yaml capability_imports[]`.
// `id` and `version` both flow into git operations / filesystem paths, so both
// use capabilityRefIdSchema (SAFE_PATH_SEGMENT + notDotRef) — validated here at
// the Zod layer and again inside systemCapabilityCachePath (R-PATH, ADR-042).
export const capabilityImportEntrySchema = z.object({
  id: capabilityRefIdSchema,
  source: z.string().min(1),
  version: capabilityRefIdSchema,
  trust: z.enum(["explicit"]).optional(),
});

export const maisterYamlV2Schema = z.object({
  schemaVersion: z.literal(2),
  project: projectBlockSchema,
  executors: z.never().optional(),
  default_executor: z.never().optional(),
  capabilities: maisterCapabilitiesSchema,
  flow_roles: z.array(flowRoleSchema).default([]),
  capability_imports: z.array(capabilityImportEntrySchema).default([]),
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
  // M17 ADR-054: flow-author-declared criticality for this HITL step.
  criticality: z.enum(["low", "medium", "high", "critical"]).optional(),
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
// `mutation_report` added in M29 (ADR-074): the deterministic post-condition
// evidence of an artifact_required gate with mutation assertions.
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
  "mutation_report",
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

// M30 (ADR-080): error codes retry_policy may auto-retry on. An ALLOW-list —
// infra-flavored, transient-by-nature codes only. PRECONDITION/CONFIG/CRASH
// and friends stay non-retryable: retrying them repeats a deterministic
// failure (or worse, replays side effects).
export const RETRYABLE_ERROR_CODES = [
  "SPAWN",
  "EXECUTOR_UNAVAILABLE",
  "CHECKPOINT",
  "ACP_PROTOCOL",
] as const;

// M30 (ADR-080): node-level auto-retry, only on ai_coding/cli nodes.
// `attempts` is the TOTAL attempt bound (1 = no retry). `workspace` is
// applied via the ADR-079 checkpoint engine BEFORE each retry; the
// rewind-to-node-checkpoint default restores the exact pre-attempt state.
// Declaring this key requires compat.engine_min >= 1.4.0 (validated in
// validateGraphManifest).
export const retryPolicySchema = z
  .object({
    attempts: z.number().int().min(1),
    on_errors: z.array(z.enum(RETRYABLE_ERROR_CODES)).min(1),
    workspace: workspacePolicySchema.default("rewind-to-node-checkpoint"),
  })
  .strict();

export type RetryPolicy = z.infer<typeof retryPolicySchema>;

// M30 (ADR-081): rework session policy — whether a rework re-entry of an
// agent node RESUMES the prior attempt's ACP session (critique context
// preserved; ~$0.28 respawn when idle) or starts clean. Resolved
// highest-wins: rework-transition > node > flow defaults > engine default
// `resume` (a deliberate flip). Declaring it requires engine_min >= 1.4.0.
export const sessionPolicySchema = z.enum(["resume", "new_session"]);

export type SessionPolicy = z.infer<typeof sessionPolicySchema>;

const gateKindSchema = z.enum([
  "command_check",
  "skill_check",
  "ai_judgment",
  "artifact_required",
  "external_check",
  "human_review",
]);

// --- M16 §A: additive `external` block (only on kind: external_check) -------
// Describes a CI/external system whose verdict is reported via the M16
// operations API. Additive — NO engine bump. `staleOnNewCommit` defaults to
// true so an omitted value re-stales a passed gate when a fresh commit arrives.
const gateExternalSchema = z
  .object({
    description: z.string().min(1).optional(),
    staleOnNewCommit: z.boolean().default(true),
  })
  .strict();

const gateCalibrationSchema = z
  .object({
    confidence_min: z.number().min(0).max(1).optional(),
    allow_missing_confidence: z.boolean().optional(),
  })
  .strict();

export const gateSchema = z
  .object({
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
    external: gateExternalSchema.optional(),
    calibration: gateCalibrationSchema.optional(),
    // M29 (ADR-074): deterministic mutation assertions, valid ONLY on
    // kind: artifact_required (superRefine below). `must_not_touch` v1 accepts
    // only the literal "restrictions" — it reads the node's resolved M14
    // restriction set, never an own path list.
    must_touch: z.array(z.string().min(1)).min(1).optional(),
    must_not_touch: z.literal("restrictions").optional(),
  })
  .superRefine((gate, ctx) => {
    if (gate.external && gate.kind !== "external_check") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["external"],
        message: "`external` block is only valid on kind: external_check",
      });
    }

    if (
      gate.calibration &&
      gate.kind !== "ai_judgment" &&
      gate.kind !== "skill_check"
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["calibration"],
        message: `\`calibration\` block is only valid on kind: ai_judgment or skill_check (got: ${gate.kind})`,
      });
    }

    const hasMutationAssertions =
      gate.must_touch !== undefined || gate.must_not_touch !== undefined;

    if (hasMutationAssertions && gate.kind !== "artifact_required") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["must_touch"],
        message: `\`must_touch\`/\`must_not_touch\` are only valid on kind: artifact_required (got: ${gate.kind})`,
      });
    }

    if (gate.output?.kind === "mutation_report" && !hasMutationAssertions) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["output", "kind"],
        message:
          'gate output kind "mutation_report" requires must_touch or must_not_touch assertions',
      });
    }

    if (
      hasMutationAssertions &&
      gate.output !== undefined &&
      gate.output.kind !== "mutation_report"
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["output", "kind"],
        message: `a gate declaring must_touch/must_not_touch must declare output kind "mutation_report" (got: ${gate.output.kind})`,
      });
    }
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
    // M26 (ADR-063): opt-in structured-output declaration. `schema` is a
    // relative `./path` resolved+validated as a formSchemaSchema doc at runtime
    // (resolveOutputResultSchema). `required` defaults to false at the seam.
    result: z
      .object({
        schema: z.string().min(1),
        required: z.boolean().optional(),
      })
      .strict()
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
  // M30 (ADR-081): transition-level session policy — highest precedence.
  session_policy: sessionPolicySchema.optional(),
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
    gemini: z.array(z.string().min(1)).optional(),
    opencode: z.array(z.string().min(1)).optional(),
    mimo: z.array(z.string().min(1)).optional(),
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
const runnerPermissionPolicySchema = z.enum([
  "default",
  "dangerously_skip_permissions",
]);

const runnerProviderRequirementSchema = z
  .object({
    kind: z.enum(PROVIDER_KINDS),
    base_url: z.string().url().optional(),
    project_id: z.string().min(1).optional(),
    location: z.string().min(1).optional(),
    wire_api: z.enum(["responses"]).optional(),
    requires_auth_token: z.boolean().optional(),
    requires_api_key: z.boolean().optional(),
  })
  .strict();

const runnerSidecarRequirementSchema = z
  .object({
    kind: z.literal("ccr"),
    optional: z.boolean().default(false),
  })
  .strict();

const runnerProfileCapabilitiesSchema = z
  .object({
    mcps: z.array(z.string().min(1)).optional(),
    tools: agentToolsSchema.optional(),
    skills: z.array(z.string().min(1)).optional(),
    restrictions: z.array(z.string().min(1)).optional(),
  })
  .strict();

export const flowRunnerProfileSchema = z
  .object({
    runner_type: z.literal("acp").default("acp"),
    capability_agent: capabilityAgentSchema,
    adapter: capabilityAgentSchema.optional(),
    model: z.string().min(1).optional(),
    model_family: z.string().min(1).optional(),
    provider: runnerProviderRequirementSchema.optional(),
    permission_policy: runnerPermissionPolicySchema.default("default"),
    sidecar: runnerSidecarRequirementSchema.optional(),
    capabilities: runnerProfileCapabilitiesSchema.optional(),
  })
  .strict();

// M27/T-C6 (§3.2): a node's MCP selection is either a bare `string[]`
// (back-compat — treated as `additional`) or a `{ required?, additional? }`
// split. REQUIRED MCPs gate launch (T-C8); ADDITIONAL are best-effort. Both
// branches are validated against the project registry by the hard-gate.
const nodeMcpsSchema = z.union([
  z.array(z.string().min(1)),
  z
    .object({
      required: z.array(z.string().min(1)).optional(),
      additional: z.array(z.string().min(1)).optional(),
    })
    .strict(),
]);

export type NodeMcpsConfig = z.infer<typeof nodeMcpsSchema>;

export function normalizeNodeMcps(mcps: NodeMcpsConfig | undefined): {
  required: string[];
  additional: string[];
} {
  if (mcps === undefined) return { required: [], additional: [] };
  if (Array.isArray(mcps)) return { required: [], additional: [...mcps] };

  return { required: mcps.required ?? [], additional: mcps.additional ?? [] };
}

// Deduped union of required + additional — the full selected set for a node.
export function allNodeMcpRefs(mcps: NodeMcpsConfig | undefined): string[] {
  const { required, additional } = normalizeNodeMcps(mcps);

  return [...new Set([...required, ...additional])];
}

export const aiCodingSettingsSchema = z
  .object({
    runner_type: z.literal("acp").default("acp"),
    runner: z.string().min(1).optional(),
    // M33 (ADR-088): bind the node to a catalog agent — the agent's .md body
    // substitutes the inline prompt (mode=session) or materializes into
    // .claude/agents/ (mode=subagent). Requires compat.engine_min >= 1.5.0.
    agent: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9._-]+$/)
      .optional(),
    executors: z.never().optional(),
    model: z.string().min(1).optional(),
    thinkingEffort: thinkingEffortSchema.optional(),
    mcps: nodeMcpsSchema.optional(),
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
    mcps: nodeMcpsSchema.optional(),
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
    // M17 ADR-054: flow-author-declared criticality for this HITL node.
    criticality: z.enum(["low", "medium", "high", "critical"]).optional(),
  })
  .strict();

// T4: form-collection (intake) HITL node settings. Unlike humanSettingsSchema
// (decision-driven review), a form node only declares the JSON form_schema doc
// it collects against; it finishes on `transitions.success` with the submitted
// values exposed as the node's output vars. `settings` is REQUIRED on a form
// node (the form_schema is the whole point), unlike the optional settings on a
// human node.
export const formSettingsSchema = z
  .object({
    form_schema: z.string().min(1),
    roles: z.array(z.string().min(1)).optional(),
    criticality: z.enum(["low", "medium", "high", "critical"]).optional(),
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
  // M30 (ADR-080): auto-retry — agent + cli nodes only.
  retry_policy: retryPolicySchema.optional(),
  // M30 (ADR-081): node-level rework session policy.
  session_policy: sessionPolicySchema.optional(),
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
  // M30 (ADR-080): auto-retry — agent + cli nodes only.
  retry_policy: retryPolicySchema.optional(),
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

// T4: form intake node — collects values against `settings.form_schema` and
// finishes on `transitions.success`. No `action` (it is a HITL collection node,
// like human); `settings` is required.
const formNodeSchema = z.object({
  ...nodeCommon,
  type: z.literal("form"),
  settings: formSettingsSchema,
});

export const nodeSchema = z.discriminatedUnion("type", [
  aiCodingNodeSchema,
  judgeNodeSchema,
  cliNodeSchema,
  checkNodeSchema,
  humanNodeSchema,
  formNodeSchema,
]);

// M22 (ADR-064): additive, runner-ignored presentation section — per-node
// canvas display options (position/size/color) keyed by node `id`, authored
// WITH the flow and shipped in the bundle. The flow-graph view reads it; dagre
// seeds any node without an entry. The engine never reads this, so the
// logic-only DSL invariant holds with no engine bump. Per-project runtime
// drag-persist deliberately does NOT live here: a pinned bundle is shared and
// immutable, so layout EDITING belongs to the flow editor on the source
// flow.yaml, not a runtime write into this section.
export const flowNodePresentationSchema = z
  .object({
    id: z.string().min(1),
    x: z.number().optional(),
    y: z.number().optional(),
    width: z.number().positive().optional(),
    height: z.number().positive().optional(),
    color: z.string().min(1).optional(),
  })
  .strict();

export const flowPresentationSchema = z
  .object({
    nodes: z.array(flowNodePresentationSchema).optional(),
  })
  .strict();

// Optional manifest `metadata` block: routing hints + provenance links. Additive
// and runner-ignored — stored verbatim in `flow_revisions.manifest`. Modeled
// (not passthrough) so the strict sub-objects reject malformed links/sources.
export const flowMetadataLinkSchema = z
  .object({
    kind: z.string().min(1).optional(),
    title: z.string().min(1),
    url: z.string().url(),
  })
  .strict();

export const flowMetadataSourceSchema = z
  .object({
    component: z.string().min(1),
    origin: z.string().min(1),
  })
  .strict();

export const flowMetadataSchema = z
  .object({
    title: z.string().min(1).optional(),
    summary: z.string().min(1).optional(),
    labels: z.array(z.string().min(1)).optional(),
    route_when: z.string().min(1).optional(),
    links: z.array(flowMetadataLinkSchema).optional(),
    sources: z.array(flowMetadataSourceSchema).optional(),
  })
  .strict();

export const flowYamlV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    name: z.string().min(1),
    metadata: flowMetadataSchema.optional(),
    recommended_executor: z.never().optional(),
    runner_profiles: z
      .record(capabilityRefIdSchema, flowRunnerProfileSchema)
      .optional(),
    setup: z.string().min(1).optional(),
    // Package contract (M10): recorded + displayed as opaque metadata; only
    // `compat` and `schemaVersion` are enforced today. Semantic validation of
    // capabilities/gates/artifacts/external_ops lands with M11+ (see ADR-021).
    compat: flowCompatSchema.optional(),
    capabilities: z.array(z.string().min(1)).optional(),
    gates: z.array(z.string().min(1)).optional(),
    artifacts: z.array(z.string().min(1)).optional(),
    external_ops: z.array(z.string().min(1)).optional(),
    // M27/T-C6 (ADR-070): package-level REQUIRED MCP declaration — capability
    // ref ids the flow package needs. The hard-gate rejects unknown refs
    // (CONFIG); launch refuses a required MCP that cannot materialize (T-C8).
    mcps: z.array(z.string().min(1)).optional(),
    // M15: flow-level calibration default, folded into each ai_judgment/skill_check
    // gate's effective calibration at compile time.
    verdict_calibration: z
      .object({ confidence_min: z.number().min(0).max(1).optional() })
      .strict()
      .optional(),
    // M30 (ADR-081): flow-level defaults — today only the rework session
    // policy. Lowest declared precedence (above the engine default only).
    defaults: z
      .object({ session_policy: sessionPolicySchema.optional() })
      .strict()
      .optional(),
    // Exactly one of `steps` (linear) or `nodes` (graph v1) is present —
    // enforced by the .refine below (ADR-026). `steps` was required before
    // M11a; it is now optional so the refine can reject both-absent.
    steps: z.array(stepSchema).min(1).optional(),
    nodes: z.array(nodeSchema).min(1).optional(),
    // Additive presentation metadata (ADR-064); runner/engine never reads it.
    presentation: flowPresentationSchema.optional(),
  })
  .refine((d) => (d.steps ? 1 : 0) + (d.nodes ? 1 : 0) === 1, {
    message: "flow manifest must declare exactly one of steps[] or nodes[]",
  });

// M26 (ADR-063): the grammar gains a nested `object` type with recursive
// `fields`, so a structured node output can declare a tree. Recursion needs an
// explicit element type for `z.lazy`; all prior flat types are unchanged.
type FormFieldShape = {
  name: string;
  label?: string;
  type: "string" | "number" | "boolean" | "enum" | "array" | "object";
  required?: boolean;
  default?: unknown;
  options?: string[];
  fields?: FormFieldShape[];
};

const formFieldSchema: z.ZodType<FormFieldShape> = z.lazy(() =>
  z.object({
    name: z.string().min(1),
    label: z.string().min(1).optional(),
    type: z.enum(["string", "number", "boolean", "enum", "array", "object"]),
    required: z.boolean().optional(),
    default: z.unknown().optional(),
    options: z.array(z.string()).optional(),
    fields: z.array(formFieldSchema).optional(),
  }),
);

export const formSchemaSchema = z.object({
  schemaVersion: z.number().int().positive(),
  fields: z.array(formFieldSchema),
});

export type MaisterYamlV2 = z.infer<typeof maisterYamlV2Schema>;
export type FlowEntry = z.infer<typeof flowEntrySchema>;
export type FlowRunnerProfile = z.infer<typeof flowRunnerProfileSchema>;
export type CapabilityImportEntry = z.infer<typeof capabilityImportEntrySchema>;
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
export type AgentDefinitionCapabilityConfig = z.infer<
  typeof agentDefinitionCapabilitySchema
>;
export type EnvProfileCapabilityConfig = z.infer<
  typeof envProfileCapabilitySchema
>;
export type MaisterCapabilitiesConfig = z.infer<
  typeof maisterCapabilitiesSchema
>;
export type FlowYamlV1 = z.infer<typeof flowYamlV1Schema>;
export type FlowMetadata = z.infer<typeof flowMetadataSchema>;
export type FlowPresentation = z.infer<typeof flowPresentationSchema>;
export type FlowNodePresentation = z.infer<typeof flowNodePresentationSchema>;
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
export type FormSettings = z.infer<typeof formSettingsSchema>;
export type CliCheckSettings = z.infer<typeof cliCheckSettingsSchema>;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];
export type NodeOutput = z.infer<typeof nodeOutputSchema>;
