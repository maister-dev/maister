import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { ExecutionHosts } from "@/lib/execution-host";
import type { SpecialistIntakeReceipt } from "./intake-types";
import type { AssignmentOrigin } from "./types";

import { manualSpecialistAssignmentRequestSchema } from "./intake-types";
import { reserveCompanyUserRequest } from "./company-request-intake";
import { wakePendingSpecialistAssignment } from "./admission-wake";

import { ownerSchema } from "@/lib/company/types";
import { contentDigest } from "@/lib/evaluations/digest";
import { MaisterError } from "@/lib/errors";
import { createExecutionHosts } from "@/lib/execution-host";

export const companyManualAssignmentRequestSchema =
  manualSpecialistAssignmentRequestSchema
    .extend({ owner: ownerSchema.options[0] })
    .strict();

/** Reserve company manual work through canonical intake and the existing native launchers. */
export async function reserveCompanyManualAssignment(
  db: Db,
  userId: string,
  value: unknown,
  hosts: ExecutionHosts = createExecutionHosts({ db }),
): Promise<SpecialistIntakeReceipt> {
  const parsed = companyManualAssignmentRequestSchema.safeParse(value);

  if (!parsed.success)
    throw new MaisterError(
      "CONFIG",
      "Manual company work requires a bounded original request and idempotency key",
    );
  const request = parsed.data;
  const origin: AssignmentOrigin = {
    kind: "manual",
    interactionId: contentDigest({
      schemaVersion: 1,
      kind: "company_manual_assignment",
      userId,
      idempotencyKey: request.idempotencyKey,
    }),
  };
  const { idempotencyKey: _key, ...originalRequest } = request;

  return reserveCompanyUserRequest(
    db,
    userId,
    originalRequest,
    origin,
    "manual",
    hosts,
  );
}

/** Wake the existing scheduler after durable intake, including a replay of interrupted admission. */
export async function submitCompanyManualAssignment(
  db: Db,
  userId: string,
  value: unknown,
): Promise<SpecialistIntakeReceipt> {
  const receipt = await reserveCompanyManualAssignment(db, userId, value);

  await wakePendingSpecialistAssignment(db, receipt);

  return receipt;
}
