import "server-only";

import { DrizzleQueryError } from "drizzle-orm";

import { safeErrorCauseChain } from "../../../runtime/safe-error-cause";

import {
  pgErrorOf,
  queryErrorDiagnostics,
  redactQueryError,
} from "@/lib/db/pg-error";
import { isMaisterError, MaisterError } from "@/lib/errors-core";

export type PrivateCreateFailureScope = Readonly<{
  runId: string;
  assignmentId: string | null;
  assignmentEpoch?: number | null;
  stage?:
    "session_create_admission" | "scratch_create_handoff" | "session_create";
}>;

function privateQueryCause(error: unknown): boolean {
  const seen = new Set<object>();
  let current = error;

  for (
    let depth = 0;
    depth < 8 && current !== null && current !== undefined;
    depth += 1
  ) {
    if (typeof current !== "object") return depth > 0;
    if (seen.has(current)) return true;
    seen.add(current);
    if (
      current instanceof DrizzleQueryError ||
      "query" in current ||
      "params" in current ||
      "errors" in current ||
      pgErrorOf(current)
    )
      return true;
    current = "cause" in current ? current.cause : undefined;
  }

  return current !== null && current !== undefined;
}

/** Private SQL parameters never escape this boundary through message, stack or a nested cause. */
export function projectPrivateCreateFailure(
  error: unknown,
  scope: PrivateCreateFailureScope,
): MaisterError {
  const redacted = redactQueryError(error);
  const immediateCause =
    error && typeof error === "object" && "cause" in error
      ? error.cause
      : undefined;

  if (
    isMaisterError(redacted) &&
    redacted === immediateCause &&
    !privateQueryCause(redacted)
  )
    return redacted;
  if (isMaisterError(error) && !privateQueryCause(error)) return error;
  const causeChain = safeErrorCauseChain(error);
  const diagnostics = queryErrorDiagnostics(error);
  const constraint =
    diagnostics.constraint &&
    /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(diagnostics.constraint)
      ? diagnostics.constraint
      : undefined;
  const knownReason =
    isMaisterError(error) &&
    typeof error.details?.reason === "string" &&
    /^[a-z][a-z0-9_]{0,127}$/.test(error.details.reason)
      ? error.details.reason
      : undefined;
  const projected = new MaisterError(
    isMaisterError(error) ? error.code : "CRASH",
    "Session creation admission failed; inspect the safe execution diagnostics",
    {
      details: {
        reason: knownReason ?? "private_create_admission_failed",
        stage: scope.stage ?? "session_create_admission",
        runId: scope.runId,
        assignmentId: scope.assignmentId,
        ...(scope.assignmentEpoch === undefined
          ? {}
          : { assignmentEpoch: scope.assignmentEpoch }),
        errorType: causeChain[0]?.name ?? "Error",
        ...(diagnostics.sqlState ? { sqlState: diagnostics.sqlState } : {}),
        ...(constraint ? { constraint } : {}),
        causeChain,
      },
    },
  );

  return projected;
}
