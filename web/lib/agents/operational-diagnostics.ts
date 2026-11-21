import { z } from "zod";

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

const workspaceIntegrityLimitSchema = z
  .object({
    reason: z.literal("operational_integrity_limit"),
    stage: z.enum([
      "baseline",
      "materialization",
      "dispatch",
      "final_verification",
      "cleanup",
      "evidence_capture",
    ]),
    resource: z.enum(["primary", "context"]),
    limitAxis: z.enum(["bytes", "entries", "time", "worktree_config_bytes"]),
    unit: z.enum(["B", "entries", "ms"]),
    observed: z.number().int().nonnegative(),
    maximum: z.number().int().positive(),
    observedEntries: z.number().int().nonnegative(),
    observedBytes: z.number().int().nonnegative(),
    elapsedMs: z.number().int().nonnegative(),
  })
  .refine(
    ({ limitAxis, unit }) =>
      unit ===
      (limitAxis === "time" ? "ms" : limitAxis === "entries" ? "entries" : "B"),
  );

export type WorkspaceIntegrityLimit = z.infer<
  typeof workspaceIntegrityLimitSchema
>;

export function readWorkspaceIntegrityLimit(
  error: unknown,
): WorkspaceIntegrityLimit | undefined {
  if (!error || typeof error !== "object" || !("details" in error))
    return undefined;
  const details = error.details;
  if (!details || typeof details !== "object" || !("integrityLimit" in details))
    return undefined;
  return parseWorkspaceIntegrityLimit(details.integrityLimit);
}

export function parseWorkspaceIntegrityLimit(
  value: unknown,
): WorkspaceIntegrityLimit | undefined {
  const result = workspaceIntegrityLimitSchema.safeParse(value);

  return result.success ? result.data : undefined;
}

export type OperationalFailureDiagnostic = OperationalProbeContext &
  Readonly<{
    probeOperation?: string;
    integrityLimit?: WorkspaceIntegrityLimit;
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

  const integrityLimit = readWorkspaceIntegrityLimit(error);

  return {
    ...context,
    ...(integrityLimit ? { integrityLimit } : {}),
    ...(typeof operation === "string" && /^[a-z.-]{1,64}$/.test(operation)
      ? { probeOperation: operation }
      : {}),
    causeChain: operationalCauseChain(cause),
  };
}
