// Typed domain errors shared by the web and host adapters.

export type MaisterErrorCode =
  | "PRECONDITION"
  | "SPAWN"
  | "NEEDS_INPUT"
  | "HITL_TIMEOUT"
  | "CRASH"
  | "CONFLICT"
  | "CONFIG"
  | "EXECUTOR_UNAVAILABLE"
  | "FLOW_INSTALL"
  | "ACP_PROTOCOL"
  | "CHECKPOINT"
  | "BUDGET_EXCEEDED"
  | "EMBEDDING_UNAVAILABLE"
  | "STEP_CHECKPOINTED"
  | "UNAUTHENTICATED"
  | "UNAUTHORIZED"
  | "PASSWORD_CHANGE_REQUIRED"
  | "ACCOUNT_INACTIVE";

export const MAISTER_ERROR_CODES = [
  "PRECONDITION",
  "SPAWN",
  "NEEDS_INPUT",
  "HITL_TIMEOUT",
  "CRASH",
  "CONFLICT",
  "CONFIG",
  "EXECUTOR_UNAVAILABLE",
  "FLOW_INSTALL",
  "ACP_PROTOCOL",
  "CHECKPOINT",
  "BUDGET_EXCEEDED",
  "EMBEDDING_UNAVAILABLE",
  "STEP_CHECKPOINTED",
  "UNAUTHENTICATED",
  "UNAUTHORIZED",
  "PASSWORD_CHANGE_REQUIRED",
  "ACCOUNT_INACTIVE",
] as const satisfies readonly MaisterErrorCode[];

export function isMaisterErrorCode(value: unknown): value is MaisterErrorCode {
  return (
    typeof value === "string" &&
    (MAISTER_ERROR_CODES as readonly string[]).includes(value)
  );
}

export class MaisterError extends Error {
  readonly code: MaisterErrorCode;
  // ADR-093: additive, optional structured context (e.g. the advisory clone
  // { reason, detail }). Never replaces `code` — the UI still branches on code.
  readonly details?: Record<string, unknown>;

  constructor(
    code: MaisterErrorCode,
    message: string,
    options?: ErrorOptions & { details?: Record<string, unknown> },
  ) {
    super(message, options);
    this.name = "MaisterError";
    this.code = code;
    this.details = options?.details;
    Object.setPrototypeOf(this, MaisterError.prototype);
  }
}

export function isMaisterError(err: unknown): err is MaisterError {
  return err instanceof MaisterError;
}
