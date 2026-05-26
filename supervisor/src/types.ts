import { z } from "zod";

export const ExecutorAgentSchema = z.enum(["claude", "codex"]);

export const ExecutorRouterSchema = z.enum(["ccr"]);

export const ExecutorSchema = z.object({
  agent: ExecutorAgentSchema,
  model: z.string().min(1),
  env: z.record(z.string(), z.string()).optional(),
  router: ExecutorRouterSchema.optional(),
});

export const StartSessionRequestSchema = z.object({
  runId: z.string().min(1),
  projectSlug: z
    .string()
    .min(1)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "projectSlug must be kebab-case"),
  worktreePath: z.string().min(1),
  stepId: z.string().min(1),
  prompt: z.string(),
  executor: ExecutorSchema,
  resumeSessionId: z.string().min(1).optional(),
});

export type ExecutorAgent = z.infer<typeof ExecutorAgentSchema>;
export type ExecutorRouter = z.infer<typeof ExecutorRouterSchema>;
export type Executor = z.infer<typeof ExecutorSchema>;
export type StartSessionRequest = z.infer<typeof StartSessionRequestSchema>;

export type StartSessionResponse = {
  sessionId: string;
  pid: number;
};

export type SessionStatus = "live" | "exited" | "crashed";

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
};

export type SessionEvent =
  | {
      type: "session.line";
      sessionId: string;
      monotonicId: number;
      line: string;
    }
  | {
      type: "session.exited";
      sessionId: string;
      monotonicId: number;
      exitCode: number;
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
  | "CRASH";

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
    case "SPAWN":
    case "ACP_PROTOCOL":
    case "CHECKPOINT":
    case "CRASH":
      return 500;
  }
}
