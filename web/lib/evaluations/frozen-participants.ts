import "server-only";

import type { Db } from "@/lib/evaluations/db";

import { eq, inArray } from "drizzle-orm";

import {
  evaluationEvidenceSnapshots,
  evaluationExecutions,
  evaluationParticipants,
} from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";

export interface FrozenParticipant {
  id: string;
  runId: string | null;
}

// The execution's FROZEN participant universe (Codex-4): the keys of its sealed
// evidence snapshot's `participant_watermarks` — the capture-time freeze point —
// NEVER live Study membership. A participant tombstoned mid-flight stays in the
// set; one added after capture never enters it. Ordered by the same
// (displayOrder, id) comparator provisioning has always used, so the round-robin
// pair orientation is stable across re-drives. Fail-closed: an execution without
// an attached snapshot has no frozen universe (PRECONDITION), never a silent
// fallback to live membership.
export async function frozenExecutionParticipants(
  executionId: string,
  d: Db,
): Promise<FrozenParticipant[]> {
  const [exec] = await d
    .select({ evidenceSnapshotId: evaluationExecutions.evidenceSnapshotId })
    .from(evaluationExecutions)
    .where(eq(evaluationExecutions.id, executionId));

  if (!exec) {
    throw new MaisterError(
      "PRECONDITION",
      `evaluation execution not found: ${executionId}`,
    );
  }

  if (!exec.evidenceSnapshotId) {
    throw new MaisterError(
      "PRECONDITION",
      `execution ${executionId} has no evidence snapshot — the participant set is not frozen`,
    );
  }

  const [snapshot] = await d
    .select({
      participantWatermarks: evaluationEvidenceSnapshots.participantWatermarks,
    })
    .from(evaluationEvidenceSnapshots)
    .where(eq(evaluationEvidenceSnapshots.id, exec.evidenceSnapshotId));

  if (!snapshot) {
    throw new MaisterError(
      "PRECONDITION",
      `evidence snapshot not found for execution ${executionId}`,
    );
  }

  const watermarks = snapshot.participantWatermarks ?? {};
  const ids = Object.keys(watermarks);

  if (ids.length === 0) return [];

  // Ordering metadata only — tombstoned participants are deliberately included.
  const rows = await d
    .select({
      id: evaluationParticipants.id,
      displayOrder: evaluationParticipants.displayOrder,
    })
    .from(evaluationParticipants)
    .where(inArray(evaluationParticipants.id, ids));

  const displayOrderById = new Map(rows.map((r) => [r.id, r.displayOrder]));

  const runIdOf = (participantId: string): string | null => {
    const watermark = watermarks[participantId];

    if (typeof watermark !== "object" || watermark === null) return null;
    const runId = (watermark as { runId?: unknown }).runId;

    return typeof runId === "string" ? runId : null;
  };

  return ids
    .sort((x, y) => {
      const ax = displayOrderById.get(x) ?? 0;
      const ay = displayOrderById.get(y) ?? 0;

      if (ax !== ay) return ax - ay;

      return x < y ? -1 : 1;
    })
    .map((id) => ({ id, runId: runIdOf(id) }));
}
