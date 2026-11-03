import type { SafeErrorCause } from "../../../runtime/safe-error-cause";

import { safeErrorCauseChain as operationalCauseChain } from "../../../runtime/safe-error-cause";

export { operationalCauseChain };
export type SafeOperationalCause = SafeErrorCause;

export type OperationalProbeContext = Readonly<{
  runId?: string;
  assignmentId?: string;
  assignmentEpoch?: number;
  preparationId?: string;
  stage?: string;
}>;

export type OperationalFailureDiagnostic = OperationalProbeContext &
  Readonly<{
    probeOperation?: string;
    causeChain: readonly SafeOperationalCause[];
  }>;

export function operationalFailureDiagnostic(
  error: unknown,
  context: OperationalProbeContext,
): OperationalFailureDiagnostic {
  const details =
    error &&
    typeof error === "object" &&
    "details" in error &&
    error.details &&
    typeof error.details === "object"
      ? error.details
      : null;
  const operation =
    details && "probeOperation" in details ? details.probeOperation : null;
  const cause =
    error && typeof error === "object" && "cause" in error
      ? error.cause
      : error;

  return {
    ...context,
    ...(typeof operation === "string" && /^[a-z.-]{1,64}$/.test(operation)
      ? { probeOperation: operation }
      : {}),
    causeChain: operationalCauseChain(cause),
  };
}
