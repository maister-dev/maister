// Client-safe core of the MaisterError taxonomy. NO `server-only` guard, so
// client modules (e.g. the flow-graph editor reducers in
// `lib/flows/editor/editor-state.ts`, bundled into the canvas) can throw and
// branch on a typed domain error without pulling a server-only module into the
// client bundle. The server-facing `@/lib/errors` re-exports these and keeps
// its server-only boundary for server-side error handling.

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
  | "STEP_CHECKPOINTED"
  | "UNAUTHENTICATED"
  | "UNAUTHORIZED"
  | "PASSWORD_CHANGE_REQUIRED"
  | "ACCOUNT_INACTIVE";

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
