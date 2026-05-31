import path from "node:path";

import { z } from "zod";

export const ExecutorAgentSchema = z.enum(["claude", "codex"]);

export const ExecutorRouterSchema = z.enum(["ccr"]);

export const ExecutorSchema = z.object({
  agent: ExecutorAgentSchema,
  model: z.string().min(1),
  env: z.record(z.string(), z.string()).optional(),
  router: ExecutorRouterSchema.optional(),
});

const SAFE_PATH_SEGMENT = /^[A-Za-z0-9._-]+$/;

const worktreePathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (p) => p.startsWith("/") && !p.split("/").includes(".."),
    "worktreePath must be an absolute path with no '..' segments",
  );

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
});

export type ExecutorAgent = z.infer<typeof ExecutorAgentSchema>;
export type ExecutorRouter = z.infer<typeof ExecutorRouterSchema>;
export type Executor = z.infer<typeof ExecutorSchema>;
export type AdapterLaunch = z.infer<typeof AdapterLaunchSchema>;
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

export type SessionRecord = {
  sessionId: string;
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
