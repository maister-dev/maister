import "server-only";

import type { InteractiveTaskLaunchPrincipal } from "@/lib/tasks/admission-types";
import type { Db } from "@/lib/execution-host/db";
import type { SpecialistIntakeReceipt } from "./intake-types";

import { sql } from "drizzle-orm";

import { projectRoutedManualAssignmentRequestSchema } from "./intake-types";
import { submitProjectManualAssignment } from "./project-manual-intake";
import { authorizeAssignment } from "./access";
import { beginAssignmentTransaction } from "./store";

import { MaisterError } from "@/lib/errors";
import { redactQueryError } from "@/lib/db/pg-error";

/** Resolve only immutable route identity before canonical replay; provider readiness remains a new-work concern. */
export async function submitProjectRoutedManualAssignment(
  db: Db,
  userId: string,
  projectId: string,
  agentId: string,
  value: unknown,
  launchPrincipal?: InteractiveTaskLaunchPrincipal,
): Promise<SpecialistIntakeReceipt> {
  const parsed = projectRoutedManualAssignmentRequestSchema.safeParse(value);

  if (!parsed.success)
    throw new MaisterError(
      "CONFIG",
      "Project routed work requires a closed version-one assignment envelope",
    );
  const owner = { kind: "project" as const, projectId };

  try {
    const bindingId = await db.transaction(async (tx) => {
      await beginAssignmentTransaction(tx);
      for (const action of ["assignments:read", "assignments:submit"] as const)
        await authorizeAssignment(tx, userId, owner, action, {
          preset: "supervised",
        });
      const binding = (
        await tx.execute(
          sql`SELECT id FROM agent_project_links WHERE project_id=${projectId} AND agent_id=${agentId} FOR SHARE`,
        )
      ).rows[0];

      if (typeof binding?.id !== "string")
        throw new MaisterError(
          "PRECONDITION",
          "The addressed project specialist attachment is unavailable",
        );

      return binding.id;
    });

    return await submitProjectManualAssignment(
      db,
      userId,
      {
        ...parsed.data.assignment,
        owner,
        specialistBindingId: bindingId,
        idempotencyKey: parsed.data.idempotencyKey,
      },
      launchPrincipal,
    );
  } catch (error) {
    throw redactQueryError(error);
  }
}
