import { isMaisterError, type MaisterError } from "@/lib/errors-core";

/** A current writer owns admission; retry preserves the same accepted work. */
export function isTaskLaunchContention(error: unknown): error is MaisterError {
  return (
    isMaisterError(error) &&
    error.code === "CONFLICT" &&
    (error.details?.reason === "operation_busy" ||
      error.details?.reason === "delegation_execution_busy")
  );
}
