import { z } from "zod";

import { MaisterError } from "@/lib/errors-core";

const identifier = z.string().min(1).max(256).nullable();

export const taskLaunchConflictReferenceSchema = z
  .object({
    intentId: identifier,
    runId: identifier,
    basis: z.enum(["manual", "automatic", "execution_child", "historical"]),
  })
  .strict()
  .refine((value) => value.intentId !== null || value.runId !== null);

export type TaskLaunchConflictReference = z.infer<
  typeof taskLaunchConflictReferenceSchema
>;

/** Only the server's already-authorized task reservation lookup supplies this reference. */
export function taskLaunchReservationConflict(
  existing: TaskLaunchConflictReference,
): MaisterError {
  return new MaisterError(
    "CONFLICT",
    "This task already has accepted delivery work",
    {
      details: { reason: "launch_already_reserved", existing },
    },
  );
}
