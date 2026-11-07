import type { SQL } from "drizzle-orm";

import { sql } from "drizzle-orm";

/** Correlated to the actual invocation alias; a generic queued attempt conveys no native source authority. */
export function queuedProjectSourceHandoffPredicate(): SQL {
  return sql`(invocation.outcome='queued' AND invocation.company_id IS NULL
    AND invocation.specialist_assignment IS NOT NULL
    AND invocation.specialist_assignment->'source'->>'attemptId'=invocation.id
    AND invocation.specialist_assignment->'source'->>'scheduleId'=invocation.schedule_id
    AND invocation.specialist_assignment->'source'->>'runId'=invocation.reserved_run_id
    AND EXISTS(SELECT 1 FROM specialist_assignments head
      JOIN specialist_input_revisions input ON input.assignment_id=head.id AND input.revision=head.input_revision
      WHERE head.id=invocation.specialist_assignment->'assignment'->>'id'
        AND head.project_id=invocation.project_id AND head.company_id IS NULL
        AND head.responsible->>'id'=invocation.source_agent_id
        AND head.project_task_id IS NOT NULL AND head.status='queued'
        AND to_jsonb(input.revision)=invocation.specialist_assignment->'assignment'->'inputRevision'
        AND input.digest=invocation.specialist_assignment->'assignment'->>'inputSha256'))`;
}
