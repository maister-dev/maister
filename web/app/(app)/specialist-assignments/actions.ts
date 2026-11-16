"use server";

import { requireActiveSession } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import { isMaisterError, type MaisterErrorCode } from "@/lib/errors";
import { writeBackAcceptedAssignment } from "@/lib/specialist-assignments/write-back";

export async function proposeAssignmentKnowledge(
  assignmentId: string,
): Promise<
  Readonly<
    { ok: true; proposalIds: string[] } | { ok: false; code: MaisterErrorCode }
  >
> {
  try {
    const { id: userId } = await requireActiveSession();
    const proposalIds = await writeBackAcceptedAssignment(
      getDb(),
      userId,
      assignmentId,
    );

    return { ok: true, proposalIds };
  } catch (error) {
    if (isMaisterError(error)) return { ok: false, code: error.code };
    throw error;
  }
}
