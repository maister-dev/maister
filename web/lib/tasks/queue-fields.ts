import {
  DEFAULT_TASK_PRIORITY,
  type TaskPriority,
} from "@/lib/tasks/criticality";

// ADR-121 §4.2/§3-T8: ONE shared SET/CLEAR column mapper for the priority +
// advisory-confidence columns, used by BOTH the human task PATCH and the agent
// triage verdict (the two mappers diverged before this — DRY). CLEAR semantics
// (skill-context bidirectional contract): `priority` resets to 'normal' (the column
// is NOT NULL), `confidence` resets to NULL. `triage_confidence` is `numeric(4,3)`,
// stored as a string in drizzle's default numeric mode.
export type QueueWriteFields = {
  priority?: TaskPriority | null;
  triageConfidence?: number | null;
};

export function applyQueueWriteFields(
  fields: QueueWriteFields,
  set: Record<string, unknown>,
): void {
  if (fields.priority !== undefined) {
    set.priority = fields.priority ?? DEFAULT_TASK_PRIORITY;
  }

  if (fields.triageConfidence !== undefined) {
    set.triageConfidence =
      fields.triageConfidence == null ? null : String(fields.triageConfidence);
  }
}

export function hasQueueWriteFields(fields: QueueWriteFields): boolean {
  return fields.priority !== undefined || fields.triageConfidence !== undefined;
}
