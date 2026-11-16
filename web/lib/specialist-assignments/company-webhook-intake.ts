import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { SpecialistIntakeReceipt } from "./intake-types";

import { sql } from "drizzle-orm";

import { companyWebhookAssignmentSchema } from "./company-webhook-types";
import { reserveCompanyUserRequest } from "./company-request-intake";
import { wakePendingSpecialistAssignment } from "./admission-wake";

import { authorizeCompanyUserAction } from "@/lib/company/authority";
import { knowledgeDeliveryKeySchema } from "@/lib/brain/knowledge-types";
import { contentDigest } from "@/lib/evaluations/digest";
import { MaisterError } from "@/lib/errors";
import { redactQueryError } from "@/lib/db/pg-error";

/** A rotated personal token preserves the same server-user endpoint identity and cannot repeat one delivery. */
export async function submitCompanyWebhookAssignment(
  db: Db,
  userId: string,
  agentId: string,
  deliveryId: string | null,
  value: unknown,
): Promise<SpecialistIntakeReceipt> {
  const parsed = companyWebhookAssignmentSchema.safeParse(value);
  const key = knowledgeDeliveryKeySchema.safeParse(deliveryId);

  if (!parsed.success || !key.success)
    throw new MaisterError(
      "CONFIG",
      "Company webhook intake requires a version-one assignment and bounded Idempotency-Key",
    );
  const request = parsed.data.assignment;

  try {
    await db.transaction(async (tx) => {
      for (const action of ["assignments:read", "assignments:submit"] as const)
        await authorizeCompanyUserAction(
          tx,
          userId,
          request.owner.companyId,
          action,
        );
      const binding = (
        await tx.execute(
          sql`SELECT id FROM company_specialist_bindings WHERE id=${request.specialistBindingId} AND company_id=${request.owner.companyId} AND agent_id=${agentId} FOR SHARE`,
        )
      ).rows[0];

      if (!binding)
        throw new MaisterError(
          "PRECONDITION",
          "The addressed company specialist binding is unavailable",
          {
            details: { reason: "company_binding_reference_unavailable" },
          },
        );
    });
    const receipt = await reserveCompanyUserRequest(
      db,
      userId,
      request,
      {
        kind: "webhook",
        endpointId: contentDigest({
          schemaVersion: 1,
          kind: "company_agent_webhook",
          companyId: request.owner.companyId,
          userId,
          agentId,
        }),
        deliveryId: key.data,
      },
      "webhook",
    );

    await wakePendingSpecialistAssignment(db, receipt);

    return receipt;
  } catch (error) {
    throw redactQueryError(error);
  }
}
