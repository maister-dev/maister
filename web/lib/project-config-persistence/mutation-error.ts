import { pgErrorOf } from "@/lib/db/pg-error";
import { isMaisterError, MaisterError } from "@/lib/errors";

/** Convert the durable publication guard into actionable runtime API feedback. */
export function configMutationError(error: unknown): unknown {
  if (isMaisterError(error) || pgErrorOf(error)?.code !== "55P03") return error;

  return new MaisterError(
    "CONFLICT",
    "Finish or recover the active configuration save before changing exportable settings.",
    { details: { reason: "operation_busy" } },
  );
}
