import "server-only";

import type { Db } from "@/lib/execution-host/db";

import { and, eq, sql } from "drizzle-orm";

import { hitlRequests, runs } from "@/lib/db/schema";
import {
  agentPermissionResumeSchema,
  assertAgentPermissionResumeSource,
} from "@/lib/execution-host/agent-permission-handoff";
import { PromptOwnerInvariantError } from "@/lib/execution-host/prompt-owners";
import { lockCurrentSessionAssignment } from "@/lib/execution-host/session-binding";

/** A historical result has no successor session. The existing checkpoint's
 * confirmed teardown supplies its closed lifecycle, under the current grant.
 */
export async function lockAgentPermissionResult(
  tx: Db,
  runId: string,
  commandId: string,
): Promise<Readonly<{ state: "exited"; persistent: boolean }> | null> {
  const [run] = await tx
    .select()
    .from(runs)
    .where(eq(runs.id, runId))
    .for("update");

  if (
    run?.runKind !== "agent" ||
    run.status !== "Running" ||
    !run.executionAssignmentId
  )
    return null;
  const assignment = await lockCurrentSessionAssignment(tx, {
    runId,
    assignmentId: run.executionAssignmentId,
  });

  if (!assignment || assignment.placementReason !== "resume") return null;
  const members = await tx
    .select()
    .from(hitlRequests)
    .where(
      and(
        eq(hitlRequests.runId, runId),
        sql`${hitlRequests.response}->'_agentResume'->>'kind' = 'result'`,
        sql`${hitlRequests.response}->'_agentResume'->>'sourceCommandId' = ${commandId}`,
        sql`${hitlRequests.response}->'_agentResume'->>'assignmentId' = ${assignment.id}`,
      ),
    )
    .for("update");

  if (!members.length) return null;
  for (const hitl of members) {
    const source = await assertAgentPermissionResumeSource(
      tx,
      hitl,
      assignment,
    );
    const grant = agentPermissionResumeSchema.parse(
      (hitl.response as Record<string, unknown>)._agentResume,
    );

    if (
      source.kind !== "result" ||
      !hitl.respondedAt ||
      source.turn.state !== "dispatched" ||
      grant.turnId !== source.turn.id ||
      grant.applied
    )
      throw new PromptOwnerInvariantError(
        "agent_permission_result_application",
      );
  }

  return { state: "exited", persistent: run.persistent };
}
