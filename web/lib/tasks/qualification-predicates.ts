import { sql, type SQL } from "drizzle-orm";

import { tasks } from "@/lib/db/schema";

/** Database freshness only; the admission owner separately verifies the local repository SHA. */
export function taskQualificationAdmittedPredicate(): SQL {
  return sql`(${tasks.qualificationMode} IN ('legacy','execution_child') OR EXISTS(
    SELECT 1 FROM task_qualifications qualification WHERE qualification.id=${tasks.currentQualificationId}
      AND qualification.task_id=${tasks.id} AND qualification.project_id=${tasks.projectId}
      AND qualification.publication_state='accepted' AND qualification.value->>'decision'='ready'
      AND qualification.input_revision=${tasks.qualificationInputRevision}
      AND qualification.revision=${tasks.currentQualificationRevision}))`;
}

export function incomingRequestPredicate(): SQL {
  return sql`(${tasks.qualificationMode}='required' AND NOT ${taskQualificationAdmittedPredicate()})`;
}

export function acceptedBacklogPredicate(): SQL {
  return sql`(${tasks.qualificationMode}<>'execution_child' AND ${taskQualificationAdmittedPredicate()})`;
}

/** Explicit none/triage-only intent cannot be replaced by an agent enqueue proposal. */
export function taskTriageAutoEnqueuePredicate(): ReturnType<typeof sql> {
  return sql`(${tasks.launchIntent} IS NULL OR ${tasks.launchIntent}='triage_then_launch')`;
}
