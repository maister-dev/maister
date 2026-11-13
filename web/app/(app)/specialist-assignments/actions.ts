"use server";

import { requireActiveSession } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import { isMaisterError, type MaisterErrorCode } from "@/lib/errors";
import {
  cancelSpecialistAssignment,
  getSpecialistAssignment,
  recoverSpecialistAssignment,
} from "@/lib/specialist-assignments/store";
import { writeBackAcceptedAssignment } from "@/lib/specialist-assignments/write-back";

type Receipt = Readonly<{ ok: true } | { ok: false; code: MaisterErrorCode }>;

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

export async function cancelAssignment(
  assignmentId: string,
  revision: number,
  reason: string,
): Promise<Receipt> {
  try {
    const { id: userId } = await requireActiveSession();
    const db = getDb();

    await getSpecialistAssignment(db, userId, assignmentId);
    await cancelSpecialistAssignment(
      db,
      userId,
      assignmentId,
      revision,
      reason,
    );

    return { ok: true };
  } catch (error) {
    if (isMaisterError(error)) return { ok: false, code: error.code };
    throw error;
  }
}

export async function reopenAssignment(
  assignmentId: string,
  revision: number,
): Promise<Receipt> {
  try {
    const { id: userId } = await requireActiveSession();
    const db = getDb();

    await getSpecialistAssignment(db, userId, assignmentId);
    await recoverSpecialistAssignment(db, userId, assignmentId, revision);

    return { ok: true };
  } catch (error) {
    if (isMaisterError(error)) return { ok: false, code: error.code };
    throw error;
  }
}
