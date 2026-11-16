import type { SQL } from "drizzle-orm";

import { sql } from "drizzle-orm";

/** Automatic creation stays system-attributed; only its exact canonical native intent links the original human requester. */
export function projectAssignmentInitiatorPolicy(
  scope: Readonly<{
    runId: SQL;
    createdByUserId: SQL;
    projectId: SQL;
    taskId: SQL;
    userId: SQL;
    assignmentId: SQL;
    inputRevision: SQL;
    inputSha256: SQL;
  }>,
): SQL {
  return sql`(${scope.createdByUserId}=${scope.userId} OR (
    ${scope.createdByUserId} IS NULL AND EXISTS (
      SELECT 1 FROM task_launch_intents initiating_intent
      WHERE initiating_intent.run_id=${scope.runId} AND initiating_intent.original_run_id=${scope.runId}
        AND initiating_intent.project_id=${scope.projectId} AND initiating_intent.task_id=${scope.taskId}
        AND initiating_intent.state='run_bound' AND initiating_intent.principal_kind='system'
        AND initiating_intent.settings_snapshot->'serverExecution'->>'kind'='agent_trigger'
        AND initiating_intent.principal_id='agent_trigger:'||(initiating_intent.settings_snapshot->'serverExecution'->>'id')
        AND initiating_intent.settings_snapshot->'serverExecution'->'execution'->'specialistAssignment'->>'assignmentId'=${scope.assignmentId}
        AND initiating_intent.settings_snapshot->'serverExecution'->'execution'->'specialistAssignment'->'inputRevision'=to_jsonb(${scope.inputRevision})
        AND initiating_intent.settings_snapshot->'serverExecution'->'execution'->'specialistAssignment'->>'userId'=${scope.userId}
        AND initiating_intent.input_snapshot->>'sourceVersion'='specialist-assignment:v1:'||${scope.assignmentId}||':'||(${scope.inputRevision})::text||':'||${scope.inputSha256}
      FOR SHARE
    )))`;
}
