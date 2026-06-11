import path from "node:path";

import { z } from "zod";

const EXECUTOR_AGENTS = ["claude", "codex", "gemini", "opencode"] as const;

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
// keys (process.env) — never sent over the wire.
export const McpServerInputSchema = z
  .object({
    name: z.string().min(1).max(128),
    transport: z.enum(["stdio", "sse", "http"]).default("stdio"),
    command: z.string().min(1).max(1024).optional(),
    args: z.array(launchArgSchema).max(64).optional(),
    envKeys: z.array(z.string().min(1).max(256)).max(64).optional(),
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
    stepId: z
      .string()
      .min(1)
      .max(128)
      .regex(SAFE_PATH_SEGMENT, "stepId must match /^[A-Za-z0-9._-]+$/"),
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

export const SendPromptRequestSchema = z.object({
  stepId: z
    .string()
    .min(1)
    .max(128)
    .regex(SAFE_PATH_SEGMENT, "stepId must match /^[A-Za-z0-9._-]+$/"),
  prompt: z.string().max(1_000_000),
  // M30 (ADR-078 L2): the prompt is an answer-only gate-chat turn — while it
  // is in flight, requestPermission auto-rejects unambiguous mutating
  // toolCall kinds BEFORE any SSE emit / pending-permission registration.
  readOnlyTurn: z.boolean().optional(),
});

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
  status: SessionStatus;
  pid: number;
  startedAt: string;
  exitedAt?: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  logPath: string;
  monotonicId: number;
  acpSessionId?: string;
  // M30 (ADR-078 L2): true while a read-only gate-chat prompt is in flight on
  // this session — drives the requestPermission auto-reject.
  readOnlyTurn?: boolean;
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
