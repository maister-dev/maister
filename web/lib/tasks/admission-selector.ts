import { sql, type SQL } from "drizzle-orm";

import {
  DEFAULT_TASK_PRIORITY,
  criticalityWeightEntries,
  weightOf,
  type TaskPriority,
} from "@/lib/tasks/criticality";

// ADR-121 §4.4: the ONE selection funnel shared by the slot-free admission gate
// and the 60s poll backstop (F2). Ordering and the capacity guards live here as
// pure functions so they are unit-testable in isolation; the DB gathering + claim
// lives in the scheduler / poll under the advisory lock.

// Equal-weight tiebreak rank: resume-first (C3) < queued runs (C1) < fresh tasks
// (C2). A LOWER rank wins. Criticality weight is always the PRIMARY key (D-A), so
// this only breaks ties between same-criticality candidates.
export const CLASS_RANK = { C3: 0, C1: 1, C2: 2 } as const;

export type AdmissionClass = keyof typeof CLASS_RANK;

export type AdmissionCandidate = {
  cls: AdmissionClass;
  // Live task priority (null for a run with no backing task → normal weight).
  priority: TaskPriority | null;
  // FIFO key in epoch millis: started_at (C1), resume_requested_at (C3),
  // created_at (C2).
  fifoMs: number;
  // Opaque payload the gate uses to claim/dispatch (runId or taskId).
  ref: { runId?: string; taskId?: string } & Record<string, unknown>;
};

// Pure order: criticality weight DESC (primary, D-A), then classRank ASC
// (equal-weight resume-first tiebreak), then FIFO ASC. Stable + total.
export function orderAdmissions(
  candidates: AdmissionCandidate[],
): AdmissionCandidate[] {
  return [...candidates].sort((a, b) => {
    const wa = weightOf(a.priority);
    const wb = weightOf(b.priority);

    if (wa !== wb) return wb - wa;

    const ra = CLASS_RANK[a.cls];
    const rb = CLASS_RANK[b.cls];

    if (ra !== rb) return ra - rb;

    return a.fifoMs - b.fifoMs;
  });
}

// SQL expression yielding the criticality weight of a (nullable) priority column,
// derived from the SAME dictionary as `weightOf` (INV-4). NULL/unknown → the
// default (normal) weight so a run with no task sorts correctly.
export function priorityWeightSql(priorityCol: SQL | unknown): SQL {
  const whens = criticalityWeightEntries().map(
    ([p, w]) => sql`when ${priorityCol} = ${p} then ${w}`,
  );

  return sql`(case ${sql.join(whens, sql` `)} else ${weightOf(
    DEFAULT_TASK_PRIORITY,
  )} end)`;
}

// ADR-121 §4.4 C2 capacity guards (Backlog-task source only) — pure predicates.
// Reserve guard (INV-8): auto-drain's flow-pool footprint never exceeds
// `flowCap − reserve`, leaving ≥reserve slots for scratch/manual/resume.
export function reserveAllowsC2(
  liveFlow: number,
  flowCap: number,
  reserve: number,
): boolean {
  return liveFlow < flowCap - reserve;
}

// Per-project share guard (INV-9): live auto-drained flow runs (counting in-flight
// claims) never exceed `maxInFlightAuto`. `Infinity` ⇒ unbounded.
export function projectShareAllowsC2(
  liveAuto: number,
  maxInFlightAuto: number,
): boolean {
  return liveAuto < maxInFlightAuto;
}
