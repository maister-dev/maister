import { MaisterError } from "@/lib/errors";

// ADR-121: the criticality dictionary is the SINGLE source of ordering truth for
// the unified admission gate. Both `admitOnFreeSlot` and the promote tiebreak call
// `weightOf` — no module computes an ad-hoc priority weight (INV-4).

export const TASK_PRIORITIES = ["low", "normal", "high", "urgent"] as const;

export type TaskPriority = (typeof TASK_PRIORITIES)[number];

// A task with no explicit priority, and a run with no backing task, both sort at
// `normal` (§4.2). This is the column default and the admission fallback.
export const DEFAULT_TASK_PRIORITY: TaskPriority = "normal";

// Closed enum → integer weight, higher = more critical. The exact integers are not
// load-bearing (only their strict order is), but the gap leaves room for a future
// aging term (NG5) without colliding adjacent tiers.
const CRITICALITY_WEIGHT: Record<TaskPriority, number> = {
  low: 100,
  normal: 200,
  high: 300,
  urgent: 400,
};

// Exposed for the admission selector to build an equivalent SQL ordering
// expression (one source of truth — no second weight table).
export function criticalityWeightEntries(): Array<[TaskPriority, number]> {
  return TASK_PRIORITIES.map((p) => [p, CRITICALITY_WEIGHT[p]]);
}

export function isTaskPriority(value: unknown): value is TaskPriority {
  return (
    typeof value === "string" &&
    (TASK_PRIORITIES as readonly string[]).includes(value)
  );
}

// Total over the closed enum. `null`/`undefined` (no task, or a legacy row) fall
// back to the default weight; an out-of-set string is corruption (the DB CHECK
// makes it unreachable through the write paths) and fails closed with CONFIG.
export function weightOf(priority: TaskPriority | null | undefined): number {
  if (priority == null) return CRITICALITY_WEIGHT[DEFAULT_TASK_PRIORITY];

  if (!isTaskPriority(priority)) {
    throw new MaisterError("CONFIG", `unknown task priority: ${priority}`);
  }

  return CRITICALITY_WEIGHT[priority];
}
