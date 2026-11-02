import "server-only";

import type {
  CommandApplicationError,
  CommandApplicationFailure,
} from "./types";

import { redactRuntimeEventPayload } from "./runtime-events";

import { MaisterError } from "@/lib/errors";

/** A valid owner is awaiting another durable domain transition, not failing. */
export class PromptOwnerDeferred extends MaisterError {
  constructor(causeCode: string) {
    super("PRECONDITION", "prompt owner awaits a durable domain transition", {
      details: { reason: "prompt_owner_deferred", causeCode },
    });
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class PromptOwnerInvariantError extends MaisterError {
  constructor(causeCode: string) {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(causeCode))
      throw new MaisterError(
        "CONFIG",
        "prompt owner invariant requires a bounded diagnostic code",
      );
    super("CONFLICT", "prompt owner application failed its invariant", {
      details: { reason: "prompt_owner_invariant", causeCode },
    });
    Object.setPrototypeOf(this, PromptOwnerInvariantError.prototype);
  }
}

type DiagnosticValue =
  | null
  | string
  | number
  | boolean
  | DiagnosticValue[]
  | { [key: string]: DiagnosticValue };

function boundedDiagnostic(value: unknown, depth = 0): DiagnosticValue {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return value.slice(0, 512);
  if (typeof value === "number")
    return Number.isFinite(value) ? value : String(value);
  if (depth >= 3) return "[TRUNCATED]";
  if (Array.isArray(value))
    return value.slice(0, 8).map((item) => boundedDiagnostic(item, depth + 1));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 16)
        .map(([key, item]) => [key, boundedDiagnostic(item, depth + 1)]),
    );

  return String(value).slice(0, 512);
}

/** Preserve typed root causes without persisting raw prompts, paths or secrets. */
export function promptApplicationDiagnostic(
  error: unknown,
): Pick<
  CommandApplicationError,
  "causeCode" | "causeReason" | "causeMessage" | "causeDetails"
> {
  const domain = error instanceof MaisterError ? error : null;
  const diagnostic = redactRuntimeEventPayload({
    message:
      error instanceof Error
        ? error.message.slice(0, 2048)
        : "Unknown prompt application failure",
    details: boundedDiagnostic(domain?.details ?? {}),
  });

  return {
    causeCode:
      error instanceof PromptOwnerInvariantError
        ? String(error.details?.causeCode)
        : (domain?.code ?? "application_failure"),
    ...(typeof domain?.details?.reason === "string"
      ? { causeReason: domain.details.reason.slice(0, 128) }
      : {}),
    causeMessage: String(diagnostic.message),
    causeDetails: diagnostic.details as Record<string, unknown>,
  };
}

/** A nonrecursive snapshot keeps the first recovery cause bounded across rearming. */
export function promptApplicationFailureSnapshot(
  error: CommandApplicationError,
): CommandApplicationFailure {
  return {
    reason: error.reason,
    phase: error.phase,
    stage: error.stage,
    causeCode: error.causeCode,
    causeReason: error.causeReason,
    causeMessage: error.causeMessage,
    causeDetails: error.causeDetails,
    classification: error.classification,
    recoveryError: error.recoveryError,
  };
}

/** Latest diagnostics must not reset recovery provenance or the durable wait deadline. */
export function preservePromptApplicationHistory(
  previous: CommandApplicationError | null,
  next: CommandApplicationError,
): CommandApplicationError {
  return {
    ...next,
    deferredSince: previous?.deferredSince ?? next.deferredSince,
    recoveryRequestedAt:
      previous?.recoveryRequestedAt ?? next.recoveryRequestedAt,
    previousAttempts: previous?.previousAttempts ?? next.previousAttempts,
    recoveryOrigin: previous?.recoveryOrigin ?? next.recoveryOrigin,
    recoveryError: next.recoveryError ?? previous?.recoveryError,
  };
}
