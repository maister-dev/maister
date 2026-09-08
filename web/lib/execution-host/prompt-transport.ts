import { CommandEvidenceError } from "../../../runtime/command-evidence";

import { isMaisterError } from "@/lib/errors";

export type PromptTransportFailure = Readonly<{
  disposition: "retry" | "reconcile" | "not_sent";
  causeCode: string;
  httpStatus?: number;
}>;

/** A response or failed read does not prove the original prompt failed. Only
 * explicit local preflight evidence proves that this attempt was not sent.
 */
export function classifyPromptTransportFailure(
  error: unknown,
): PromptTransportFailure {
  if (!isMaisterError(error))
    return { disposition: "reconcile", causeCode: "transport_protocol" };
  const status = error.details?.httpStatus;
  const httpStatus =
    typeof status === "number" &&
    Number.isInteger(status) &&
    status >= 100 &&
    status <= 599
      ? status
      : undefined;

  return {
    disposition:
      error.details?.transport === "not_sent"
        ? "not_sent"
        : error.details?.transport === "unknown_outcome" ||
            error.code === "EXECUTOR_UNAVAILABLE"
          ? "retry"
          : "reconcile",
    causeCode: error.code,
    ...(httpStatus === undefined ? {} : { httpStatus }),
  };
}

/** Closed protocol failures are distinct from unavailable or absent evidence. */
export function isPromptProtocolConflict(error: unknown): boolean {
  return (
    error instanceof CommandEvidenceError ||
    (isMaisterError(error) &&
      (error.details?.reason === "prompt_admission_mismatch" ||
        error.details?.reason === "command_invariant_conflict"))
  );
}
