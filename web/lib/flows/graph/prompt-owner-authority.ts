import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { PromptOwner } from "@/lib/execution-host/prompt-owner-contract";

import { and, eq } from "drizzle-orm";

import {
  assertNodePermissionContinuation,
  assertGatePermissionContinuation,
} from "@/lib/execution-host/permission-handoff-source";
import {
  runSessionIncarnations,
  runSessions,
  nodeAttempts,
  gateResults,
} from "@/lib/db/schema";
import { lockCurrentSessionAssignment } from "@/lib/execution-host/session-binding";

export type FlowOwnerRef = Extract<
  PromptOwner,
  { kind: "flow_node_attempt" }
>["ref"];

export async function lockFlowPromptOwner(
  tx: Db,
  ref: FlowOwnerRef,
  targetSessionId: string | null,
): Promise<boolean> {
  const assignment = await lockCurrentSessionAssignment(tx, {
    runId: ref.runId,
    assignmentId: ref.assignmentId,
  });

  if (!assignment || assignment.epoch !== ref.assignmentEpoch) return false;
  const [binding] = await tx
    .select({ id: runSessionIncarnations.id })
    .from(runSessions)
    .innerJoin(
      runSessionIncarnations,
      eq(runSessionIncarnations.runSessionId, runSessions.id),
    )
    .where(
      and(
        eq(runSessions.id, ref.runSessionId),
        eq(runSessions.runId, ref.runId),
        eq(runSessions.executionAssignmentId, assignment.id),
        eq(runSessionIncarnations.id, ref.incarnationId),
        eq(runSessionIncarnations.executionAssignmentId, assignment.id),
        eq(runSessionIncarnations.assignmentEpoch, assignment.epoch),
        eq(runSessionIncarnations.executionHostId, assignment.executionHostId),
        eq(runSessionIncarnations.hostSessionId, targetSessionId ?? ""),
        eq(runSessions.hostSessionId, targetSessionId ?? ""),
      ),
    )
    .for("update")
    .limit(1);

  if (!binding) return false;
  if (ref.variant === "node" || ref.variant === "permission_resume") {
    const [attempt] = await tx
      .select()
      .from(nodeAttempts)
      .where(eq(nodeAttempts.id, ref.nodeAttemptId));

    if (attempt)
      await assertNodePermissionContinuation(tx, attempt, assignment);
  } else if (ref.variant === "gate_ai" || ref.variant === "gate_skill") {
    const [evaluation] = await tx
      .select()
      .from(gateResults)
      .where(eq(gateResults.id, ref.evaluationId));

    if (evaluation?.permissionResume?.kind === "permission_continue")
      await assertGatePermissionContinuation(tx, evaluation, assignment.id);
  }

  return true;
}
