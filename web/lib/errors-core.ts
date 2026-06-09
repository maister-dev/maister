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
  | "STEP_CHECKPOINTED"
  | "UNAUTHENTICATED"
  | "UNAUTHORIZED"
  | "PASSWORD_CHANGE_REQUIRED"
  | "ACCOUNT_INACTIVE";

export class MaisterError extends Error {
  readonly code: MaisterErrorCode;

  constructor(code: MaisterErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MaisterError";
    this.code = code;
    Object.setPrototypeOf(this, MaisterError.prototype);
  }
}

export function isMaisterError(err: unknown): err is MaisterError {
  return err instanceof MaisterError;
}
