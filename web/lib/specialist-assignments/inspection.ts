import "server-only";

import type { SqlDatabase } from "@/lib/db/sql-types";
import type { SpecialistAssignment } from "./types";

import { resolveAssignmentContextPrincipal } from "./context-access";
import { readSpecialistAssignmentContextInTransaction } from "./context";
import {
  beginAssignmentTransaction,
  getVisibleSpecialistAssignmentInTransaction,
  inspectExecutingAssignmentInTransaction,
} from "./store";

import { recordKnowledgeDisclosure } from "@/lib/brain/knowledge-disclosure";
import { restrictionsForKnowledgeAccess } from "@/lib/brain/knowledge-restrictions";
import { redactQueryError } from "@/lib/db/pg-error";

/** Actual execution inspection captures every current input/context dependency before returning assignment bytes. */
export async function getSpecialistAssignmentToken(
  db: SqlDatabase,
  tokenId: string,
  assignmentId: string,
): Promise<SpecialistAssignment> {
  try {
    return await db.transaction(async (tx) => {
      await beginAssignmentTransaction(tx);
      const principal = await resolveAssignmentContextPrincipal(
        tx,
        { kind: "token", tokenId },
        "assignments:read",
      );

      if (principal.source.kind === "user")
        return getVisibleSpecialistAssignmentInTransaction(
          tx,
          principal.source.userId,
          assignmentId,
        );
      const context = await readSpecialistAssignmentContextInTransaction(
        tx,
        principal.source,
        assignmentId,
      );
      const inspection = await inspectExecutingAssignmentInTransaction(
        tx,
        principal.source,
        assignmentId,
      );

      await recordKnowledgeDisclosure(tx, principal.consumer, [
        ...restrictionsForKnowledgeAccess(context.access),
        ...restrictionsForKnowledgeAccess(inspection.access),
      ]);

      return inspection.value;
    });
  } catch (error) {
    throw redactQueryError(error);
  }
}
