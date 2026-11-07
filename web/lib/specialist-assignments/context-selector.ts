import "server-only";
import { assignmentContextReadSchema } from "./context-types";

import { MaisterError } from "@/lib/errors";

/** HTTP decimal selectors preserve the same integer bounds as the native facade without coercing malformed values. */
export function selectAssignmentContextRevision(
  parameters: URLSearchParams,
): number | undefined {
  const values = parameters.getAll("revision");
  const raw = values[0];

  if (
    values.length > 1 ||
    (raw !== undefined &&
      (!/^(0|[1-9][0-9]*)$/.test(raw) ||
        !assignmentContextReadSchema.shape.revision.safeParse(Number(raw))
          .success))
  )
    throw new MaisterError(
      "CONFIG",
      "Context revision must be one canonical nonnegative integer",
    );

  return raw === undefined ? undefined : Number(raw);
}
