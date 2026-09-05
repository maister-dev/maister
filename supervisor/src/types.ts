import { z } from "zod";

const EXECUTOR_AGENTS = [
  "claude",
  "codex",
  "gemini",
  "opencode",
  "mimo",
] as const;

export const ExecutorAgentSchema = z.enum(EXECUTOR_AGENTS);

// A bare `.` / `..` is made of allowed characters but names the directory
// itself or its parent, so it must never reach a path join as an id.
const SAFE_PATH_SEGMENT = /^(?!\.{1,2}$)[A-Za-z0-9._-]+$/;

function safeSegmentMessage(field: string): string {
  return `${field} must match /${SAFE_PATH_SEGMENT.source}/`;
}

export const ExecutorSchema = z
  .object({
    agent: ExecutorAgentSchema,
    model: z.string().min(1),
    env: z.record(z.string(), z.string()).optional(),
  })
  .strict();

const envNameSchema = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "must be an environment variable name");

const runnerEnvValueSchema = z
  .string()
  .refine(
    (value) => !value.includes("\0"),
    "env value must not contain null byte",
  )
  .refine(
    (value) =>
      !value.startsWith("env:") || /^env:[A-Za-z_][A-Za-z0-9_]*$/.test(value),
    "env ref value must be env:NAME",
  );

// Adoption paths (the workspace path, `repoPath`, and every context-mount
// path) are shape-validated only here: the workspace registry owns the D7
// rule tokens (`relative_path`, `parent_segment`, …) so a refusal always
// names its rule.
const adoptPathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((p) => !p.includes("\0"), "path must not contain null byte");

const RuntimeObjectOutputBindingSchema = z
  .object({
    objectId: z.string().uuid(),
    kind: z.enum([
      "session_log",
      "raw_transcript",
      "cost_diagnostic",
      "checkpoint",
      "attachment",
      "capability_profile",
      "agent_memory_snapshot",
      "node_result",
      "evidence",
      "generated_artifact",
      "plan_review",
      "diagnostic",
    ]),
    logicalName: z
      .string()
      .min(1)
      .max(255)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "logicalName must be a basename"),
    mimeType: z.string().min(1).max(255),
    generation: z.number().int().min(1),
    retentionClass: z.enum(["run", "delivery", "ephemeral"]),
    expiresAt: z.string().datetime({ offset: true }).nullable().optional(),
    envName: z.enum([
      "MAISTER_OUTPUT_FILE",
      "MAISTER_PLAN_DOCUMENT_FILE",
      "MAISTER_PLAN_REVIEW_FILE",
    ]),
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.retentionClass === "ephemeral") !== Boolean(value.expiresAt)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["expiresAt"],
        message:
          "expiresAt must be present exactly for ephemeral runtime objects",
      });
    }
  });

export type RuntimeObjectOutputBinding = z.infer<
  typeof RuntimeObjectOutputBindingSchema
>;

export const RunnerProviderSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("anthropic") }).strict(),
  z
    .object({
      kind: z.literal("anthropic_compatible"),
      baseUrl: z.string().url().optional(),
      authTokenEnv: envNameSchema.optional(),
    })
    .strict(),
  z.object({ kind: z.literal("openai") }).strict(),
  z
    .object({
      kind: z.literal("openai_compatible"),
      baseUrl: z.string().url().optional(),
      apiKeyEnv: envNameSchema.optional(),
      wireApi: z.literal("responses").optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("google_gemini"),
      apiKeyEnv: envNameSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("google_vertex"),
      projectId: z.string().min(1).optional(),
      location: z.string().min(1).optional(),
      apiKeyEnv: envNameSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("google_gateway"),
      baseUrl: z.string().url().optional(),
      apiKeyEnv: envNameSchema.optional(),
    })
    .strict(),
  z.object({ kind: z.literal("agent_native") }).strict(),
]);

export const RunnerLaunchSchema = z
  .object({
    version: z.literal(1),
    runnerId: z.string().min(1).max(128).regex(SAFE_PATH_SEGMENT),
    adapter: ExecutorAgentSchema,
    capabilityAgent: ExecutorAgentSchema,
    model: z.string().min(1),
    provider: RunnerProviderSchema,
    permissionPolicy: z.enum(["default", "dangerously_skip_permissions"]),
    env: z.record(envNameSchema, runnerEnvValueSchema).optional(),
  })
  .strict();

const launchArgSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine((v) => !v.includes("\0"), "launch arg must not contain null byte");

const SERVER_DERIVED_RUNTIME_ENV_NAMES = new Set([
  "MAISTER_CAPABILITY_PROFILE_PATH",
  "MAISTER_CAPABILITY_INSTRUCTIONS_PATH",
  "MAISTER_OUTPUT_FILE",
  "MAISTER_PLAN_DOCUMENT_FILE",
  "MAISTER_PLAN_REVIEW_FILE",
]);

export const AdapterLaunchSchema = z
  .object({
    env: z.record(z.string().min(1), z.string()).optional(),
    preArgs: z.array(launchArgSchema).max(32).optional(),
    postArgs: z.array(launchArgSchema).max(32).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    for (const name of Object.keys(value.env ?? {})) {
      if (!SERVER_DERIVED_RUNTIME_ENV_NAMES.has(name)) continue;
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${name} is server-derived from an opaque runtime object`,
        path: ["env", name],
      });
    }
  });

// M27/T-C4: transport-tagged. stdio uses command/args/envKeys; sse/http use
// url/headerKeys. Header/env VALUES are resolved supervisor-side from the NAME
// keys (process.env) — never sent over the wire. Exception (M34, ADR-089):
// `env` carries literal values for server-GENERATED secrets that exist in no
// process.env (the per-launch ephemeral agent token injected into the MCP
// facade) — same trust channel as executor.env/adapterLaunch.env.
export const McpServerInputSchema = z
  .object({
    name: z.string().min(1).max(128),
    transport: z.enum(["stdio", "sse", "http"]).default("stdio"),
    command: z.string().min(1).max(1024).optional(),
    args: z.array(launchArgSchema).max(64).optional(),
    envKeys: z.array(z.string().min(1).max(256)).max(64).optional(),
    env: z.record(z.string().min(1).max(256), z.string()).optional(),
    url: z.string().url().max(2048).optional(),
    headerKeys: z.array(z.string().min(1).max(256)).max(64).optional(),
  })
  .strict()
  .superRefine((s, ctx) => {
    if (s.transport === "stdio" && !s.command) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "stdio MCP server requires a command",
        path: ["command"],
      });
    }
    if ((s.transport === "sse" || s.transport === "http") && !s.url) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${s.transport} MCP server requires a url`,
        path: ["url"],
      });
    }
  });

// ADR-130: derived capability-enforcement set for the capability_guard seam
// interceptor. Present iff the resolved node/agent declares strict tools/mcps on an
// enforceable adapter. Seeded onto SessionRecord like hooksConfig; read at the
// requestPermission seam. `tools.allow` is never empty (a strict class with no
// declared allow-set is a web-side CONFIG refusal). `escalationThreshold` (N) is
// web-resolved and delivered here so the supervisor stays config-free.
export const SessionEnforcementProfileSchema = z
  .object({
    tools: z
      .object({ allow: z.array(z.string().min(1)).min(1) })
      .strict()
      .optional(),
    mcps: z
      .object({ allowServers: z.array(z.string().min(1)) })
      .strict()
      .optional(),
    enforcedClasses: z.array(z.enum(["tools", "mcps"])).min(1),
    escalationThreshold: z.number().int().min(1),
  })
  .strict();

export type SessionEnforcementProfile = z.infer<
  typeof SessionEnforcementProfileSchema
>;

// ADR-157: ONE read-only sibling-repo context mount the web tier already
// materialized for this session. A first-class request field (the
// opaque capability-input precedent) — never an `executor.env` overload, which
// is the provider-secret channel. The supervisor derives
// `MAISTER_CONTEXT_REPOS` + the prompt preamble from it and denies write-class
// tool calls resolving under `path`; it never resolves a slug or a ref, and
// never creates or removes a worktree. Bounds mirror
// `StartSessionRequest.contextMounts[]` in docs/api/supervisor.openapi.yaml.
export const ContextMountSchema = z
  .object({
    slug: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "mount slug must be kebab-case"),
    path: adoptPathSchema,
    ref: z.string().min(1).max(255),
    // 7..64 per the spec: an abbreviated sha and a sha-256 object id are both
    // in-contract, so this deliberately carries no 40-hex pattern.
    commit: z.string().min(7).max(64),
  })
  .strict();

export type ContextMount = z.infer<typeof ContextMountSchema>;

export const EXECUTION_WORKSPACE_ID_PATTERN = /^ws_[0-9a-f]{32}$/;

export const ExecutionWorkspaceIdSchema = z
  .string()
  .regex(
    EXECUTION_WORKSPACE_ID_PATTERN,
    "executionWorkspaceId must be ws_<32 hex>",
  );

const runIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(SAFE_PATH_SEGMENT, safeSegmentMessage("runId"));

const projectSlugSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "projectSlug must be kebab-case");

// ADR-166 (strict): a session addresses its workspace ONLY through the opaque
// handle minted by `POST /workspaces/adopt`. The pre-ADR-166 path fields are
// refused by name (`legacy_field`) BEFORE schema parsing so a stale client
// learns which field to drop instead of a generic unknown-key rejection.
export const LEGACY_SESSION_PATH_FIELDS = [
  "runId",
  "projectSlug",
  "worktreePath",
  "repoPath",
  "confineRoot",
  "contextMounts",
  "capabilityProfilePath",
  "capabilityInstructionsPath",
] as const;

export function legacySessionPathField(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;

  for (const field of LEGACY_SESSION_PATH_FIELDS) {
    if ((payload as Record<string, unknown>)[field] !== undefined) return field;
  }

  return null;
}

export const StartSessionRequestSchema = z
  .object({
    // The host derives cwd, the confinement roots, the run dir, and the
    // context mounts from the handle (server state) — never from the body.
    executionWorkspaceId: ExecutionWorkspaceIdSchema,
    stepId: z
      .string()
      .min(1)
      .max(128)
      .regex(SAFE_PATH_SEGMENT, safeSegmentMessage("stepId")),
    nodeAttemptId: z
      .string()
      .min(1)
      .max(128)
      .regex(SAFE_PATH_SEGMENT, safeSegmentMessage("nodeAttemptId"))
      .optional(),
    // M42 (ADR-114): logical Flow session this ACP process serves. Stamped onto
    // canonical usage and session-event envelopes so a multi-session run
    // attributes spend and events per session. Absent → "default" (a
    // single-session run).
    sessionName: z
      .string()
      .min(1)
      .max(128)
      .regex(SAFE_PATH_SEGMENT, safeSegmentMessage("sessionName"))
      .optional(),
    executor: ExecutorSchema,
    runner: RunnerLaunchSchema.optional(),
    resumeSessionId: z
      .string()
      .min(1)
      .max(128)
      .regex(SAFE_PATH_SEGMENT, safeSegmentMessage("resumeSessionId"))
      .optional(),
    capabilityProfileObjectId: z.string().uuid().optional(),
    capabilityInstructionsObjectId: z.string().uuid().optional(),
    outputObjects: z.array(RuntimeObjectOutputBindingSchema).max(32).optional(),
    adapterLaunch: AdapterLaunchSchema.optional(),
    mcpServers: z.array(McpServerInputSchema).max(64).optional(),
    // M34 (ADR-090 L1): session-scoped read-only — the requestPermission
    // handler auto-denies write-class tool kinds and auto-approves the
    // read-safe allow-list for the WHOLE session. Used for none/repo_read
    // platform-agent runs (headless: no HITL inbox exists for them).
    readOnlySession: z.boolean().optional(),
    // B1 (execution-policy permissions=auto_approve): the requestPermission
    // handler auto-selects the allow option for every request in this session
    // (L3, below the read-only layers — read-only always wins). Resolved from
    // the run's execution_policy snapshot at launch.
    autoApprovePermissions: z.boolean().optional(),
    // M34 lifecycle fix: a one-shot standalone agent session (non-persistent)
    // has no external driver that acts on a bare `end_turn` — unlike a flow
    // session driven by the flow runner. When set, the supervisor reaps the idle
    // adapter on `end_turn` so the heartbeat emits `session.exited` and the web
    // consumer finalizes/parks the run instead of leaking a live slot.
    reapOnEndTurn: z.boolean().optional(),
    // ADR-108 (M40): the web tier's resolved guardrail rule set. Mirrors
    // `StartSessionRequest.hooksConfig` in supervisor.openapi.yaml + the web
    // `HooksConfig` type. The acceptor must land WITH the emitter so an armed
    // run can spawn; the interceptor that enforces these arrives in Phase 2.
    // Accept-and-ignore until then (no behavioral coupling yet).
    hooksConfig: z
      .object({
        repetition: z.object({ max: z.number().int().min(1) }).strict(),
        noProgress: z.object({ maxTurns: z.number().int().min(1) }).strict(),
        // allowedPaths mirrors the web authoring schema: non-empty array of
        // non-empty globs. The resolver always fills it (>= ["**"]), so this only
        // rejects a malformed direct-POST — the two wire ends stay symmetric.
        pathGuard: z
          .object({ allowedPaths: z.array(z.string().min(1)).min(1) })
          .strict(),
      })
      .partial()
      .strict()
      .optional(),
    // ADR-130: derived capability-enforcement set (capability_guard). Optional;
    // present only for a session enforcing strict tools/mcps.
    enforcementProfile: SessionEnforcementProfileSchema.optional(),
  })
  .strict();

// --- ADR-166: execution-host contract (envelope, fences, adoption, receipts) ---

export const HOST_KEY_SCHEMA = z
  .string()
  .regex(/^[A-Za-z0-9_-]{8,64}$/, "hostKey must match ^[A-Za-z0-9_-]{8,64}$");

export const COMMAND_KINDS = [
  "workspace.adopt",
  "workspace.release",
  "session.create",
  "session.prompt",
  "session.input",
  "session.cancel",
  "session.checkpoint",
  "session.delete",
  "runtime_object.reserve",
  "runtime_object.upload",
  "runtime_object.delete",
] as const;

export const CommandKindSchema = z.enum(COMMAND_KINDS);
export type CommandKind = z.infer<typeof CommandKindSchema>;

export const FenceSchema = z
  .object({
    hostKey: HOST_KEY_SCHEMA,
    assignmentId: z.string().uuid(),
    assignmentEpoch: z.number().int().min(1),
    runId: runIdSchema,
  })
  .strict();

export type CommandFence = z.infer<typeof FenceSchema>;

export const CommandHeaderSchema = z
  .object({
    id: z.string().uuid(),
    kind: CommandKindSchema,
    issuedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export const CommandEnvelopeSchema = z
  .object({
    command: CommandHeaderSchema,
    fence: FenceSchema,
    payload: z.record(z.string(), z.unknown()),
  })
  .strict();

export type CommandEnvelope = z.infer<typeof CommandEnvelopeSchema>;

export const RUNTIME_OBJECT_KINDS = [
  "session_log",
  "raw_transcript",
  "cost_diagnostic",
  "checkpoint",
  "attachment",
  "capability_profile",
  "capability_instructions",
  "agent_memory_snapshot",
  "node_result",
  "evidence",
  "generated_artifact",
  "plan_review",
  "diagnostic",
] as const;

export const RuntimeObjectKindSchema = z.enum(RUNTIME_OBJECT_KINDS);
export const RuntimeObjectRetentionClassSchema = z.enum([
  "run",
  "delivery",
  "ephemeral",
]);
const runtimeObjectIdSchema = z.string().uuid();
const runtimeObjectLogicalNameSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "logicalName must be a basename");
const sha256Schema = z
  .string()
  .regex(/^[a-f0-9]{64}$/, "sha256 must be lowercase hex");

export const ReserveRuntimeObjectPayloadSchema = z
  .object({
    objectId: runtimeObjectIdSchema,
    kind: RuntimeObjectKindSchema,
    logicalName: runtimeObjectLogicalNameSchema,
    mimeType: z.string().min(1).max(255),
    sizeBytes: z.number().int().min(0).max(26_214_400),
    sha256: sha256Schema,
    generation: z.number().int().min(1),
    retentionClass: RuntimeObjectRetentionClassSchema,
    expiresAt: z.string().datetime({ offset: true }).nullable().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.retentionClass === "ephemeral") !== Boolean(value.expiresAt)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["expiresAt"],
        message:
          "expiresAt must be present exactly for ephemeral runtime objects",
      });
    }
  });

export type ReserveRuntimeObjectPayload = z.infer<
  typeof ReserveRuntimeObjectPayloadSchema
>;

export const RuntimeObjectUploadHeadersSchema = z
  .object({
    commandId: z.string().uuid(),
    commandIssuedAt: z.string().datetime({ offset: true }),
    assignmentId: z.string().uuid(),
    assignmentEpoch: z.coerce.number().int().min(1),
    generation: z.coerce.number().int().min(1),
    sizeBytes: z.coerce.number().int().min(0).max(26_214_400),
    sha256: sha256Schema,
    contentDigest: z.string().regex(/^sha-256=:[A-Za-z0-9+/]+={0,2}:$/),
  })
  .strict();

export const DeleteRuntimeObjectPayloadSchema = z
  .object({ generation: z.number().int().min(1) })
  .strict();

// A body is enveloped iff it carries a `command` header; anything else is
// refused by name (`missing_envelope`).
export function isEnvelopedBody(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;

  const command = (body as { command?: unknown }).command;

  return (
    typeof command === "object" &&
    command !== null &&
    typeof (command as { id?: unknown }).id === "string" &&
    typeof (command as { kind?: unknown }).kind === "string"
  );
}

export const REASON_TOKENS = [
  "host_mismatch",
  "assignment_mismatch",
  "run_mismatch",
  "assignment_fenced",
  "turn_lost",
  "unknown_workspace",
  "workspace_released",
  "workspace_rejected",
  "legacy_field",
  "missing_envelope",
  "invalid_event_sequence",
  "replay_floor_lost",
  "stream_identity_conflict",
  "ack_not_contiguous",
  "ack_beyond_emitted",
  "unsupported_event_schema",
  "event_redaction_failed",
  "event_payload_oversize",
  "event_outbox_backpressure",
  "command_invariant_conflict",
  "command_in_progress",
  "runtime_object_delete_failed",
  "runtime_object_missing",
  "runtime_object_range_invalid",
  "runtime_object_integrity_mismatch",
  "runtime_object_too_large",
] as const;

export type ReasonToken = (typeof REASON_TOKENS)[number];

export const WORKSPACE_RULES = [
  "relative_path",
  "parent_segment",
  "not_found",
  "outside_roots",
  "symlink_escape",
  "gitdir_mismatch",
  "not_a_repo",
  "repo_path_mismatch",
  "inside_state_dir",
  "outside_workspace",
] as const;

export type WorkspaceRule = (typeof WORKSPACE_RULES)[number];

export type SupervisorErrorDetails = {
  reason?: ReasonToken;
  rule?: WorkspaceRule;
  // `legacy_field`: the refused pre-ADR-166 path field, by name.
  field?: string;
  // `workspace_rejected` on a context mount: the offending mount's slug.
  mount?: string;
  runId?: string;
  commandEpoch?: number;
  hostEpoch?: number;
};

export const WORKSPACE_KINDS = [
  "git_worktree",
  "repo_checkout",
  "directory",
] as const;

export const WorkspaceKindSchema = z.enum(WORKSPACE_KINDS);
export type WorkspaceKind = z.infer<typeof WorkspaceKindSchema>;

export const AdoptWorkspacePayloadSchema = z
  .object({
    runId: runIdSchema,
    projectSlug: projectSlugSchema,
    kind: WorkspaceKindSchema,
    path: adoptPathSchema,
    repoPath: adoptPathSchema.optional(),
    contextMounts: z.array(ContextMountSchema).max(8).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.kind === "directory" && value.repoPath !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["repoPath"],
        message: "repoPath is forbidden for a directory workspace",
      });
    }
    if (value.kind !== "directory" && value.repoPath === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["repoPath"],
        message: `repoPath is required for a ${value.kind} workspace`,
      });
    }
  });

export type AdoptWorkspacePayload = z.infer<typeof AdoptWorkspacePayloadSchema>;

export const AdoptWorkspaceRequestSchema = z
  .object({
    command: CommandHeaderSchema.extend({
      kind: z.literal("workspace.adopt"),
    }).strict(),
    fence: FenceSchema,
    payload: AdoptWorkspacePayloadSchema,
  })
  .strict();

export type AdoptWorkspaceResponse = {
  executionWorkspaceId: string;
  kind: WorkspaceKind;
  replayed: boolean;
};

export type WorkspaceRecordResponse = {
  executionWorkspaceId: string;
  runId: string;
  projectSlug: string;
  kind: WorkspaceKind;
  adoptedAt: string;
  releasedAt: string | null;
};

export const CommandReceiptSchema = z
  .object({
    commandId: z.string().uuid(),
    runId: z.string().min(1),
    kind: CommandKindSchema,
    assignmentEpoch: z.number().int().min(1),
    phase: z.enum(["accepted", "completed", "rejected"]),
    httpStatus: z.number().int().min(100).max(599),
    body: z.record(z.string(), z.unknown()),
    receivedAt: z.string().datetime({ offset: true }),
    completedAt: z.string().datetime({ offset: true }).nullable().optional(),
    eventId: z.string().uuid().nullable(),
    // `accepted` + `inflight:false` = the host restarted mid-turn (turn_lost).
    inflight: z.boolean(),
  })
  .strict();

export type CommandReceiptResponse = z.infer<typeof CommandReceiptSchema>;

export const SESSION_COMMAND_KINDS = [
  "session.prompt",
  "session.input",
  "session.cancel",
  "session.checkpoint",
  "session.delete",
] as const;

export const SessionCommandEventSchema = z
  .object({
    type: z.literal("session.command"),
    sessionId: z.string().min(1),
    monotonicId: z.number().int().min(1),
    commandId: z.string().uuid(),
    kind: z.enum(SESSION_COMMAND_KINDS),
    phase: z.enum(["accepted", "completed"]),
    status: z.enum(["succeeded", "failed", "fenced"]).optional(),
    result: z.record(z.string(), z.unknown()).optional(),
    error: z.record(z.string(), z.unknown()).optional(),
    sessionName: z.string().optional(),
    nodeAttemptId: z.string().optional(),
  })
  .strict();

// T5.4: structured ACP prompt content blocks. The web tier assembles these
// (text + worktree-confined resource_link/resource) and the supervisor forwards
// them VERBATIM (verbatim-forward invariant). Validation here is shape-only;
// `.passthrough()` preserves the ACP-optional fields (annotations, mimeType,
// _meta, …) the supervisor must not strip. A `text` literal discriminates the
// union, so the closed set rejects unknown block types.
const PromptContentBlockSchema = z.union([
  z.object({ type: z.literal("text"), text: z.string() }).passthrough(),
  z
    .object({
      type: z.literal("resource_link"),
      uri: z.string().min(1),
      name: z.string().min(1),
    })
    .passthrough(),
  z
    .object({
      type: z.literal("resource"),
      resource: z.object({ uri: z.string().min(1) }).passthrough(),
    })
    .passthrough(),
  // This is a supervisor-private indirection, not an ACP content block. It
  // lets the manager supply an opaque object ID while the host derives the
  // actual confined file URI from its own object registry.
  z
    .object({
      type: z.literal("runtime_object"),
      objectId: z.string().uuid(),
      name: z.string().min(1).max(255),
      mimeType: z.string().min(1).max(255).optional(),
      description: z.string().max(4_000).optional(),
    })
    .strict(),
]);

export const SendPromptRequestSchema = z
  .object({
    stepId: z
      .string()
      .min(1)
      .max(128)
      .regex(SAFE_PATH_SEGMENT, safeSegmentMessage("stepId")),
    nodeAttemptId: z
      .string()
      .min(1)
      .max(128)
      .regex(SAFE_PATH_SEGMENT, safeSegmentMessage("nodeAttemptId"))
      .optional(),
    prompt: z.string().max(1_000_000),
    contentBlocks: z.array(PromptContentBlockSchema).max(64).optional(),
    // M30 (ADR-078 L2): the prompt is an answer-only gate-chat turn — while it
    // is in flight, requestPermission auto-rejects unambiguous mutating
    // toolCall kinds BEFORE any SSE emit / pending-permission registration.
    readOnlyTurn: z.boolean().optional(),
  })
  .strict();

// M30 (ADR-078 DD4): gate-chat prompts are tagged with this server-derived
// stepId marker (dash, not colon — SAFE_PATH_SEGMENT). The suffix is the web
// hitl_requests id; the marker also names the per-step log file.
export const GATE_CHAT_STEP_PREFIX = "gate-chat-";

export function parseGateChatHitlId(stepId: string): string | null {
  if (!stepId.startsWith(GATE_CHAT_STEP_PREFIX)) return null;
  const id = stepId.slice(GATE_CHAT_STEP_PREFIX.length);

  return id.length > 0 ? id : null;
}

export type ExecutorAgent = z.infer<typeof ExecutorAgentSchema>;
export type Executor = z.infer<typeof ExecutorSchema>;
export type RunnerLaunch = z.infer<typeof RunnerLaunchSchema>;
export type AdapterLaunch = z.infer<typeof AdapterLaunchSchema>;
export type McpServerInput = z.infer<typeof McpServerInputSchema>;
export type StartSessionRequest = z.infer<typeof StartSessionRequestSchema>;
export type SendPromptRequest = z.infer<typeof SendPromptRequestSchema>;

// ADR-108 (M40): the resolved, flat guardrail rule set delivered on
// StartSessionRequest.hooksConfig. Derived from the schema so the wire shape
// and the in-memory type cannot drift. Each key absent = that rule not armed.
export type HooksConfig = NonNullable<StartSessionRequest["hooksConfig"]>;

// ADR-108 (M40): a guardrail rule and its frozen lifecycle/disposition — see the
// rule × lifecycle matrix in docs/system-analytics/guardrail-hooks.md.
export type HookRule =
  | "path_guard"
  | "repetition"
  | "no_progress"
  | "capability_guard";
export type HookLifecycle = "pre_tool_call" | "post_turn";
export type HookDisposition = "deny" | "halt";

export type StartSessionResponse = {
  sessionId: string;
  pid: number;
  acpSessionId: string;
};

export type SendPromptResponse = {
  stopReason: "end_turn" | "max_tokens" | "max_turn_requests" | "refusal";
  meta?: unknown;
};

export type SessionStatus = "live" | "exited" | "crashed";

export const ExecutionHostIdentitySchema = z
  .object({
    hostKey: HOST_KEY_SCHEMA,
    bootId: z.string().uuid(),
    protocolVersion: z.literal(1),
  })
  .strict();

export type ExecutionHostIdentity = z.infer<typeof ExecutionHostIdentitySchema>;

export const SupervisorHealthResponseSchema = z
  .object({
    status: z.literal("ready"),
    host: ExecutionHostIdentitySchema,
    version: z.string().min(1),
    uptimeMs: z.number().int().nonnegative(),
    checkedAt: z.string().datetime(),
    sessions: z
      .object({
        live: z.number().int().nonnegative(),
        exited: z.number().int().nonnegative(),
        crashed: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();

export type SupervisorHealthResponse = z.infer<
  typeof SupervisorHealthResponseSchema
>;

const AdapterSmokeReadOnlySessionBaseSchema = z
  .object({
    reason: z.string().min(1).nullable(),
    checkedAt: z.string().datetime().nullable(),
    protocolVersion: z.number().int().positive().nullable(),
    probeVersion: z.number().int().positive().nullable(),
  })
  .strict();

const AdapterSmokeReadOnlySessionSchema = z.discriminatedUnion("status", [
  AdapterSmokeReadOnlySessionBaseSchema.extend({
    status: z.literal("stale"),
    staleReason: z.enum(["probe_contract", "freshness"]),
  }).strict(),
  AdapterSmokeReadOnlySessionBaseSchema.extend({
    status: z.enum(["not_required", "pending", "ok", "skipped", "error"]),
    staleReason: z.null(),
  }).strict(),
]);

const AdapterSmokeDiagnosticSchema = z
  .object({
    status: z.enum(["not_required", "pending", "ok", "skipped", "error"]),
    reason: z.string().min(1).nullable(),
    checkedAt: z.string().datetime().nullable(),
    protocolVersion: z.number().int().positive().nullable(),
    readOnlySession: AdapterSmokeReadOnlySessionSchema,
    // ADR-130: capabilityEnforcement is a simple dimension (no probe version /
    // staleness) — distinct from the richer read-only-session evidence.
    capabilityEnforcement: z
      .object({
        status: z.enum(["not_required", "pending", "ok", "skipped", "error"]),
        reason: z.string().min(1).nullable(),
        checkedAt: z.string().datetime().nullable(),
        protocolVersion: z.number().int().positive().nullable(),
      })
      .strict(),
  })
  .strict();

export const SupervisorDiagnosticsResponseSchema = z
  .object({
    status: z.literal("ready"),
    version: z.string().min(1),
    checkedAt: z.string().datetime(),
    adapters: z.array(
      z
        .object({
          id: ExecutorAgentSchema,
          binary: z.string().min(1),
          source: z.enum(["path", "override"]),
          path: z.string().min(1).nullable(),
          available: z.boolean(),
          version: z.string().min(1).nullable(),
          error: z.string().min(1).nullable(),
          smoke: AdapterSmokeDiagnosticSchema,
        })
        .strict(),
    ),
    envRefs: z.array(
      z
        .object({
          name: envNameSchema,
          present: z.boolean(),
        })
        .strict(),
    ),
  })
  .strict();

export type SupervisorDiagnosticsResponse = z.infer<
  typeof SupervisorDiagnosticsResponseSchema
>;

export type SessionRecord = {
  sessionId: string;
  adapter: ExecutorAgent;
  runId: string;
  projectSlug: string;
  stepId: string;
  nodeAttemptId?: string;
  // M42 (ADR-114): logical Flow session this record serves ("default" for a
  // single-session run), echoed from StartSessionRequest.sessionName.
  sessionName: string;
  status: SessionStatus;
  pid: number;
  startedAt: string;
  exitedAt?: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  logPath: string;
  // Session-bound roots for prompt content-block URI confinement (set at
  // creation; a per-prompt caller cannot change them). See prompt-confinement.ts.
  worktreePath: string;
  repoPath?: string;
  // ADR-097: project-less local-package session — the sole confinement root.
  confineRoot?: string;
  monotonicId: number;
  acpSessionId?: string;
  // ADR-166: the adopted handle this session runs in, and the fence of the
  // `session.create` command that spawned it.
  executionWorkspaceId: string;
  assignmentId: string;
  assignmentEpoch: number;
  createdByCommandId: string;
  // ADR-166: set when a command with a HIGHER assignment epoch evicted this
  // session; its pending prompt answers 409 FENCED instead of a stop reason.
  fencedByEpoch?: number;
  // M30 (ADR-078 L2): true while a read-only gate-chat prompt is in flight on
  // this session — drives the requestPermission auto-reject.
  readOnlyTurn?: boolean;
  // M34 (ADR-090 L1): the whole session is read-only — every permission
  // request is decided inline (write-class denied, read-safe approved); no
  // pending-permission deferred is ever created.
  readOnlySession?: boolean;
  // B1 (execution-policy permissions=auto_approve): auto-select the allow
  // option for every permission request in this session, BELOW the read-only
  // layers. Resolved from the run's execution_policy snapshot in spawn.ts.
  autoApprovePermissions?: boolean;
  // M34 lifecycle: reap the idle adapter on a clean `end_turn` — set only for
  // one-shot (non-persistent) standalone agent sessions. See StartSessionRequest.
  reapOnEndTurn?: boolean;
  // ADR-108 (M40): the resolved guardrail rule set for this session. Arms the
  // universal supervisor interceptor; absent → the interceptor is a no-op
  // (byte-identical to a pre-hook run). Mirrors StartSessionRequest.hooksConfig.
  hooksConfig?: HooksConfig;
  // ADR-130: the derived capability-enforcement set for this session. Arms the
  // capability_guard interceptor; absent → capability_guard is inert. Mirrors
  // StartSessionRequest.enforcementProfile.
  enforcementProfile?: SessionEnforcementProfile;
  // ADR-130: out-of-profile denial counter — reset only by an in-profile ALLOW
  // (a governed call that cleared the allow-list). An UNGOVERNED pass_through call
  // does NOT reset it (deliberate: an agent must not evade the breaker by
  // interleaving reads between forbidden calls). The Nth
  // (enforcementProfile.escalationThreshold) latches a halt. In-memory only (lost
  // on crash, reset on resume) — mirrors the M40 counters.
  capabilityDenyCount?: number;
  // ADR-130: D5 always-ask sentinel — WRITE_KINDS toolCallIds announced by a
  // streaming `tool_call` (status:"pending") that have NOT yet reached the
  // always-ask seam. An id is added when the pending write streams and removed
  // when it reaches `requestPermission` (arbitrated). The sentinel halts iff such
  // an id is still present when its execution `tool_call_update`
  // (status completed|failed) arrives — i.e. the adapter ran a write without ever
  // asking. Keyed off the EXECUTION event (which post-dates requestPermission),
  // NOT the pre-permission pending notification, so a legitimately arbitrated
  // write never false-halts on its own streamed announcement.
  capabilityPendingWriteIds?: Set<string>;
  // ADR-108 (M40): in-memory guardrail counters — lost on supervisor crash (run
  // reconciled Crashed) and reset on resume (a respawn builds a fresh record).
  lastToolCallSig?: string;
  repeatCount?: number;
  turnsSinceProgress?: number;
  // ADR-108 (M40): set once a repetition/no_progress halt fires; every later
  // permission request is cancelled until the web tier checkpoints (the
  // supervisor never self-kills on a trip — D1).
  hookHalted?: boolean;
  // ADR-108 (M40): WARN-once-per-session guard for the kind-only path-guard
  // fallback (adapters that do not populate toolCall.locations).
  hookFallbackWarned?: boolean;
  // ADR-157: the read-only sibling-repo mounts materialized for this session.
  // Arms the UNCONDITIONAL L2 write guard in the permission handler (not opt-in
  // via hooksConfig — read-only is the mount's whole point) and the prompt
  // preamble. Absent/empty → both are inert.
  contextMounts?: ContextMount[];
  runtimeOutputObjectIds?: string[];
  // ADR-157: the mount preamble is rendered onto the FIRST prompt of this
  // session only. A resume rebuilds this record, so a respawn re-grounds.
  contextMountPreambleSent?: boolean;
  // ADR-157: WARN-once-per-session guard for a write-class call whose path the
  // adapter never reported (no toolCall.locations) — the mount guard cannot
  // verify such a call, and L3 (terminal dirty check) is the backstop.
  contextMountFallbackWarned?: boolean;
  // Interrupt (session/cancel): set by POST /sessions/:id/cancel just before the
  // protocol-level cancel notification, so the in-flight prompt's `cancelled`
  // stop reason is classified as a user interrupt (turn ends, session stays
  // live) rather than an unexpected protocol abort (which marks the run crashed).
  // Cleared once the prompt request settles.
  cancelRequested?: boolean;
};

// ADR-166: the `GET /sessions` projection. Host-private paths (`logPath`,
// `worktreePath`, `repoPath`, `confineRoot`, `contextMounts`) never leave the
// host; the web tier addresses the workspace through `executionWorkspaceId`.
export type SessionListEntry = Pick<
  SessionRecord,
  | "sessionId"
  | "adapter"
  | "runId"
  | "projectSlug"
  | "stepId"
  | "nodeAttemptId"
  | "sessionName"
  | "status"
  | "pid"
  | "startedAt"
  | "exitedAt"
  | "exitCode"
  | "signal"
  | "monotonicId"
  | "acpSessionId"
  | "executionWorkspaceId"
  | "assignmentId"
  | "assignmentEpoch"
  | "createdByCommandId"
>;

export function toSessionListEntry(record: SessionRecord): SessionListEntry {
  return {
    sessionId: record.sessionId,
    adapter: record.adapter,
    runId: record.runId,
    projectSlug: record.projectSlug,
    stepId: record.stepId,
    nodeAttemptId: record.nodeAttemptId,
    sessionName: record.sessionName,
    status: record.status,
    pid: record.pid,
    startedAt: record.startedAt,
    exitedAt: record.exitedAt,
    exitCode: record.exitCode,
    signal: record.signal,
    monotonicId: record.monotonicId,
    acpSessionId: record.acpSessionId,
    executionWorkspaceId: record.executionWorkspaceId,
    assignmentId: record.assignmentId,
    assignmentEpoch: record.assignmentEpoch,
    createdByCommandId: record.createdByCommandId,
  };
}

export type PermissionOptionDescriptor = {
  optionId: string;
  kind?: string;
  name?: string;
};

export type SessionEvent =
  | {
      type: "session.line";
      sessionId: string;
      monotonicId: number;
      line: string;
    }
  | {
      type: "session.update";
      sessionId: string;
      monotonicId: number;
      update: unknown;
    }
  | {
      type: "session.permission_request";
      sessionId: string;
      monotonicId: number;
      requestId: string;
      options: ReadonlyArray<PermissionOptionDescriptor>;
      toolCall: unknown;
    }
  // ADR-108 (M40): a guardrail rule tripped at the supervisor ACP seam. `deny`
  // (path_guard) is resolved inline and the run continues; `halt` (repetition /
  // no_progress) is escalated by the web tier (checkpoint + NeedsInput). The web
  // consumer branches on `disposition`. `toolCall` is present for pre_tool_call
  // rules (path_guard / repetition), null for no_progress.
  | {
      type: "session.hook_trip";
      sessionId: string;
      monotonicId: number;
      rule: HookRule;
      lifecycle: HookLifecycle;
      disposition: HookDisposition;
      toolCall: unknown;
    }
  | {
      type: "session.exited";
      sessionId: string;
      monotonicId: number;
      exitCode: number;
      // M8 T4 + T17: optional reason — `"checkpoint"` for sweeper-/
      // checkpoint-endpoint-driven exits, `"intentional"` for plain
      // DELETE /sessions/:id. Absent on natural process exit (process
      // ran to completion). Web tier branches: `"checkpoint"` triggers
      // `markCheckpointed` reconciliation; `"intentional"` is the plain
      // operator-cancel path. ADR-166: `"fenced"` = evicted by a command with a
      // higher assignment epoch.
      reason?: "checkpoint" | "intentional" | "fenced";
    }
  // ADR-166: command acceptance / completion for the enveloped session routes
  // — the durable completion signal that is NOT the long-lived HTTP response.
  | {
      type: "session.command";
      sessionId: string;
      monotonicId: number;
      commandId: string;
      kind: (typeof SESSION_COMMAND_KINDS)[number];
      phase: "accepted" | "completed";
      status?: "succeeded" | "failed" | "fenced";
      result?: Record<string, unknown>;
      error?: SupervisorErrorBody;
    }
  | {
      type: "session.crashed";
      sessionId: string;
      monotonicId: number;
      exitCode: number | null;
      signal: NodeJS.Signals | null;
    }
  // M30 (ADR-078 DD4): answer-only gate-chat turn — rendered in the chat
  // surface, never the flow timeline. Emitted at gate-chat prompt completion
  // with the accumulated agent reply; `mutationReverted` stays unset here
  // (the web-side L3 sensor owns it on the persisted row).
  | {
      type: "session.chat_turn";
      sessionId: string;
      monotonicId: number;
      hitlRequestId: string;
      role: "user" | "agent";
      body: string;
      seq?: number;
      mutationReverted?: boolean;
    };

export type SupervisorErrorCode =
  | "PRECONDITION"
  | "SPAWN"
  | "EXECUTOR_UNAVAILABLE"
  | "ACP_PROTOCOL"
  | "CHECKPOINT"
  | "CRASH"
  | "HITL_TIMEOUT"
  // ADR-166: stale assignment epoch at the execution boundary (HTTP 409).
  | "FENCED";

export class SupervisorError extends Error {
  readonly code: SupervisorErrorCode;
  // ADR-166: typed refusal discriminator passed through to the web tier's
  // MaisterError.details — tests assert the token, never the message.
  readonly details?: SupervisorErrorDetails;

  constructor(
    code: SupervisorErrorCode,
    message: string,
    options?: ErrorOptions & { details?: SupervisorErrorDetails },
  ) {
    super(message, options);
    this.name = "SupervisorError";
    this.code = code;
    this.details = options?.details;
    Object.setPrototypeOf(this, SupervisorError.prototype);
  }
}

export function isSupervisorError(err: unknown): err is SupervisorError {
  return err instanceof SupervisorError;
}

export type SupervisorErrorBody = {
  code: SupervisorErrorCode;
  message: string;
  details?: SupervisorErrorDetails;
};

export function errorBody(err: SupervisorError): SupervisorErrorBody {
  return err.details
    ? { code: err.code, message: err.message, details: err.details }
    : { code: err.code, message: err.message };
}

export function httpStatusForCode(code: SupervisorErrorCode): number {
  switch (code) {
    case "PRECONDITION":
    case "FENCED":
      return 409;
    case "EXECUTOR_UNAVAILABLE":
      return 503;
    case "HITL_TIMEOUT":
      return 410;
    case "SPAWN":
    case "ACP_PROTOCOL":
    case "CHECKPOINT":
    case "CRASH":
      return 500;
  }
}
