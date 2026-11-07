import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { AssignmentOrigin } from "./types";
import type { SpecialistIntakeReceipt } from "./intake-types";

import { manualSpecialistAssignmentRequestSchema } from "./intake-types";
import { submitProjectUserRequest } from "./project-request-intake";

import { ownerSchema } from "@/lib/company/types";
import { contentDigest } from "@/lib/evaluations/digest";
import { MaisterError } from "@/lib/errors";

export const projectManualAssignmentRequestSchema =
  manualSpecialistAssignmentRequestSchema
    .extend({ owner: ownerSchema.options[1] })
    .strict();

/** Manual identity and literal input bytes are preserved across all authenticated entry points. */
export async function submitProjectManualAssignment(
  db: Db,
  userId: string,
  value: unknown,
): Promise<SpecialistIntakeReceipt> {
  const parsed = projectManualAssignmentRequestSchema.safeParse(value);

  if (!parsed.success)
    throw new MaisterError(
      "CONFIG",
      "Project specialist work requires a bounded original request and idempotency key",
    );
  const request = parsed.data;
  const origin: AssignmentOrigin = {
    kind: "manual",
    interactionId: contentDigest({
      schemaVersion: 1,
      kind: "project_manual_assignment",
      userId,
      idempotencyKey: request.idempotencyKey,
    }),
  };
  const { idempotencyKey: _key, ...originalRequest } = request;

  return submitProjectUserRequest(db, userId, originalRequest, {
    origin,
    destination: { kind: "inbox", userId },
    trigger: { source: "manual" },
    scheduledRequest: null,
    taskId: null,
  });
}
