import "server-only";

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
  | "CHECKPOINT";

export class MaisterError extends Error {
  readonly code: MaisterErrorCode;

  constructor(
    code: MaisterErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "MaisterError";
    this.code = code;
    Object.setPrototypeOf(this, MaisterError.prototype);
  }
}

export function isMaisterError(err: unknown): err is MaisterError {
  return err instanceof MaisterError;
}
