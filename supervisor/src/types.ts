import path from "node:path";

import { z } from "zod";

const EXECUTOR_AGENTS = [
  "claude",
  "codex",
  "gemini",
  "opencode",
  "mimo",
] as const;

export const ExecutorAgentSchema = z.enum(EXECUTOR_AGENTS);

export const ExecutorRouterSchema = z.enum(["ccr"]);

const SAFE_PATH_SEGMENT = /^[A-Za-z0-9._-]+$/;

export const ExecutorSchema = z.object({
  agent: ExecutorAgentSchema,
  model: z.string().min(1),
  env: z.record(z.string(), z.string()).optional(),
  router: ExecutorRouterSchema.optional(),
});

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

const worktreePathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (p) => p.startsWith("/") && !p.split("/").includes(".."),
    "worktreePath must be an absolute path with no '..' segments",
  );

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

export const RunnerSidecarSchema = z
  .object({
    id: z.string().min(1).max(128).regex(SAFE_PATH_SEGMENT),
    kind: z.literal("ccr"),
    lifecycle: z.enum(["managed", "external"]).optional(),
    configPath: worktreePathSchema.optional(),
    baseUrl: z.string().url().optional(),
    healthcheckUrl: z.string().url().optional(),
    authTokenEnv: envNameSchema.optional(),
  })
  .strict();

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
    sidecar: RunnerSidecarSchema.optional(),
  })
  .strict();

const launchArgSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine((v) => !v.includes("\0"), "launch arg must not contain null byte");

export const AdapterLaunchSchema = z
  .object({
    env: z.record(z.string().min(1), z.string()).optional(),
    preArgs: z.array(launchArgSchema).max(32).optional(),
    postArgs: z.array(launchArgSchema).max(32).optional(),
  })
  .strict();

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

export const StartSessionRequestSchema = z
  .object({
    runId: z
      .string()
      .min(1)
      .max(128)
      .regex(SAFE_PATH_SEGMENT, "runId must match /^[A-Za-z0-9._-]+$/"),
    projectSlug: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "projectSlug must be kebab-case"),
    worktreePath: worktreePathSchema,
    // Optional project repo root — the supervisor adds it to the prompt
    // content-block confinement allow-set so a `file_path` attachment that
    // references a repo-absolute path (web-confined to repo OR worktree) is not
    // rejected. Absent for runs that never send file references.
    repoPath: worktreePathSchema.optional(),
    // M36 Phase 5 (ADR-097): SOLE content-block file-URI confinement root for a
    // project-less local-package assistant session (the local-package working
    // dir). When set it replaces worktree ∪ repo as the allow-set. The cwd is
    // still `worktreePath` (= the working dir for these sessions).
    confineRoot: worktreePathSchema.optional(),
    stepId: z
      .string()
      .min(1)
      .max(128)
      .regex(SAFE_PATH_SEGMENT, "stepId must match /^[A-Za-z0-9._-]+$/"),
    nodeAttemptId: z
      .string()
      .min(1)
      .max(128)
      .regex(SAFE_PATH_SEGMENT, "nodeAttemptId must match /^[A-Za-z0-9._-]+$/")
      .optional(),
    executor: ExecutorSchema,
    runner: RunnerLaunchSchema.optional(),
    resumeSessionId: z
      .string()
      .min(1)
      .max(128)
      .regex(
        SAFE_PATH_SEGMENT,
        "resumeSessionId must match /^[A-Za-z0-9._-]+$/",
      )
      .optional(),
    capabilityProfilePath: worktreePathSchema.optional(),
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
    // ADR-104 (M40): the web tier's resolved guardrail rule set. Mirrors
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
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!value.capabilityProfilePath) return;

    const relative = path.relative(
      value.worktreePath,
      value.capabilityProfilePath,
    );

    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["capabilityProfilePath"],
        message: "capabilityProfilePath must be inside worktreePath",
      });
    }
  });

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
]);

export const SendPromptRequestSchema = z
  .object({
    stepId: z
      .string()
      .min(1)
      .max(128)
      .regex(SAFE_PATH_SEGMENT, "stepId must match /^[A-Za-z0-9._-]+$/"),
    nodeAttemptId: z
      .string()
      .min(1)
      .max(128)
      .regex(SAFE_PATH_SEGMENT, "nodeAttemptId must match /^[A-Za-z0-9._-]+$/")
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
export type ExecutorRouter = z.infer<typeof ExecutorRouterSchema>;
export type Executor = z.infer<typeof ExecutorSchema>;
export type RunnerLaunch = z.infer<typeof RunnerLaunchSchema>;
export type AdapterLaunch = z.infer<typeof AdapterLaunchSchema>;
export type McpServerInput = z.infer<typeof McpServerInputSchema>;
export type StartSessionRequest = z.infer<typeof StartSessionRequestSchema>;
export type SendPromptRequest = z.infer<typeof SendPromptRequestSchema>;

// ADR-104 (M40): the resolved, flat guardrail rule set delivered on
// StartSessionRequest.hooksConfig. Derived from the schema so the wire shape
// and the in-memory type cannot drift. Each key absent = that rule not armed.
export type HooksConfig = NonNullable<StartSessionRequest["hooksConfig"]>;

// ADR-104 (M40): a guardrail rule and its frozen lifecycle/disposition — see the
// rule × lifecycle matrix in docs/system-analytics/guardrail-hooks.md.
export type HookRule = "path_guard" | "repetition" | "no_progress";
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

export const SupervisorHealthResponseSchema = z
  .object({
    status: z.literal("ready"),
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

const AdapterSmokeDiagnosticSchema = z
  .object({
    status: z.enum(["not_required", "pending", "ok", "skipped", "error"]),
    reason: z.string().min(1).nullable(),
    checkedAt: z.string().datetime().nullable(),
    protocolVersion: z.number().int().positive().nullable(),
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
    sidecars: z.array(
      z
        .object({
          id: z.string().min(1),
          kind: z.literal("ccr"),
          state: z.enum(["idle", "starting", "ready", "failed", "stopping"]),
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
  // ADR-104 (M40): the resolved guardrail rule set for this session. Arms the
  // universal supervisor interceptor; absent → the interceptor is a no-op
  // (byte-identical to a pre-hook run). Mirrors StartSessionRequest.hooksConfig.
  hooksConfig?: HooksConfig;
  // ADR-104 (M40): in-memory guardrail counters — lost on supervisor crash (run
  // reconciled Crashed) and reset on resume (a respawn builds a fresh record).
  lastToolCallSig?: string;
  repeatCount?: number;
  turnsSinceProgress?: number;
  // ADR-104 (M40): set once a repetition/no_progress halt fires; every later
  // permission request is cancelled until the web tier checkpoints (the
  // supervisor never self-kills on a trip — D1).
  hookHalted?: boolean;
  // ADR-104 (M40): WARN-once-per-session guard for the kind-only path-guard
  // fallback (adapters that do not populate toolCall.locations).
  hookFallbackWarned?: boolean;
};

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
  // ADR-104 (M40): a guardrail rule tripped at the supervisor ACP seam. `deny`
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
      // operator-cancel path.
      reason?: "checkpoint" | "intentional";
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
  | "HITL_TIMEOUT";

export class SupervisorError extends Error {
  readonly code: SupervisorErrorCode;

  constructor(
    code: SupervisorErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SupervisorError";
    this.code = code;
    Object.setPrototypeOf(this, SupervisorError.prototype);
  }
}

export function isSupervisorError(err: unknown): err is SupervisorError {
  return err instanceof SupervisorError;
}

export type SupervisorErrorBody = {
  code: SupervisorErrorCode;
  message: string;
};

export function httpStatusForCode(code: SupervisorErrorCode): number {
  switch (code) {
    case "PRECONDITION":
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
