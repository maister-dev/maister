import { z } from "zod";

import { assignmentResultWitnessSchema } from "./delivery-types";

import { MaisterError } from "@/lib/errors";
import { postgresTextSchema } from "@/lib/text-schema";

const identity = postgresTextSchema.min(1).max(128).regex(/\S/);
const revision = z.number().int().positive().max(2147483647);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const timestamp = z.string().datetime({ offset: true });

export const assignmentDeliveryReplaySchema = z
  .object({
    schemaVersion: z.literal(1),
    expectedStateSha256: sha256,
  })
  .strict();
export type AssignmentDeliveryReplay = z.infer<
  typeof assignmentDeliveryReplaySchema
>;

export const assignmentDeliverySelectionSchema = z
  .object({
    runId: identity,
    resultRevision: revision.optional(),
  })
  .strict();
export type AssignmentDeliverySelection = z.infer<
  typeof assignmentDeliverySelectionSchema
>;

export const assignmentDeliveryViewSchema = assignmentResultWitnessSchema
  .omit({
    owner: true,
    requesterUserId: true,
    sourceRestrictions: true,
  })
  .extend({
    deliveryId: identity,
    signal: z.literal("result_available"),
    createdAt: timestamp,
    transport: z
      .object({
        id: identity.nullable(),
        state: z.enum(["awaiting_dispatch", "pending", "delivered", "dead"]),
        attemptCount: z.number().int().nonnegative().max(2147483647),
        lastAttemptNo: z.number().int().nonnegative().max(2147483647),
        lastHttpStatus: z.number().int().min(100).max(599).nullable(),
        lastErrorKind: z
          .enum(["timeout", "network", "http", "config"])
          .nullable(),
        nextAttemptAt: timestamp.nullable(),
        deliveredAt: timestamp.nullable(),
        updatedAt: timestamp.nullable(),
        stateSha256: sha256.nullable(),
      })
      .strict(),
  })
  .strict();
export type AssignmentDeliveryView = z.infer<
  typeof assignmentDeliveryViewSchema
>;

/** Refuse ambiguous selectors before any receipt lookup. */
export function parseAssignmentDeliverySelection(
  url: string,
): AssignmentDeliverySelection {
  const params = new URL(url).searchParams;

  for (const key of params.keys()) {
    if (
      !["runId", "resultRevision"].includes(key) ||
      params.getAll(key).length !== 1
    )
      throw new MaisterError(
        "CONFIG",
        "Select one runId and optional resultRevision only",
      );
  }
  const rawRevision = params.get("resultRevision");

  if (rawRevision !== null && !/^[1-9][0-9]{0,9}$/.test(rawRevision))
    throw new MaisterError(
      "CONFIG",
      "resultRevision must be a positive signed 32-bit integer",
    );
  const parsed = assignmentDeliverySelectionSchema.safeParse({
    runId: params.get("runId"),
    ...(rawRevision === null ? {} : { resultRevision: Number(rawRevision) }),
  });

  if (!parsed.success)
    throw new MaisterError("CONFIG", "Invalid assignment delivery selection");

  return parsed.data;
}

export function assertAssignmentDeliveryIdentity(value: string): void {
  if (!identity.safeParse(value).success)
    throw new MaisterError("CONFIG", "Invalid assignment delivery identity");
}
