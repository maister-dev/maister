import "server-only";

import type { InteractiveTaskLaunchPrincipal } from "@/lib/tasks/admission-types";
import type { Db } from "@/lib/execution-host/db";
import type { SpecialistIntakeReceipt } from "./intake-types";

import { manualSpecialistAssignmentRequestSchema } from "./intake-types";
import { submitCompanyManualAssignment } from "./company-manual-intake";
import { submitProjectManualAssignment } from "./project-manual-intake";

import { MaisterError } from "@/lib/errors";

/** Session and personal-token requests use the same strict input and canonical identity. */
export async function submitManualSpecialistAssignment(
  db: Db,
  userId: string,
  value: unknown,
  launchPrincipal?: InteractiveTaskLaunchPrincipal,
): Promise<SpecialistIntakeReceipt> {
  const parsed = manualSpecialistAssignmentRequestSchema.safeParse(value);

  if (!parsed.success)
    throw new MaisterError(
      "CONFIG",
      "Specialist submission requires an explicit owner, bounded original request and idempotency key",
    );

  return parsed.data.owner.kind === "project"
    ? submitProjectManualAssignment(db, userId, parsed.data, launchPrincipal)
    : submitCompanyManualAssignment(db, userId, parsed.data);
}
