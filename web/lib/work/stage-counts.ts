/**
 * The Now strip's five numbers (ADR-174 D1).
 *
 * Pure by contract, like the rest of `lib/work`: no database handle, no clock,
 * no `server-only`. The strip is a SUMMARY of the rows the table renders, so it
 * counts that array rather than issuing a query of its own — which is what makes
 * strip and table one population by construction rather than by agreement
 * (`REQ-D2`).
 */

import type { WorkTableRow } from "@/lib/queries/work-table";
import type { WorkInFlightStage } from "@/lib/work/stage";

import { isWorkInFlight } from "@/lib/work/stage";

export type WorkInFlightCounts = Record<WorkInFlightStage, number>;

// Spelled out rather than folded from `WORK_IN_FLIGHT_STAGES`, for the same
// reason the partition itself is spelled out: a SIXTH in-flight stage must be a
// compile error here, not a tile that silently never renders.
const ZERO_COUNTS = {
  Queued: 0,
  Executing: 0,
  WaitingOnHuman: 0,
  Review: 0,
  Crashed: 0,
} as const satisfies WorkInFlightCounts;

/**
 * Counts in-flight rows by stage, keyed in `WORK_IN_FLIGHT_STAGES` order.
 *
 * Every one of the five keys is present at zero: a map that omitted empty
 * stages would produce a strip whose tiles move as work arrives, destroying the
 * fixed positions a reader scans by (`REQ-D1`).
 *
 * Count BEFORE any slice. The Desk renders `DESK_WORK_ROWS` of these rows, and a
 * strip counted after the slice would answer "what is on this page" while
 * claiming to answer "what is in flight".
 */
export function countWorkInFlightByStage(
  rows: readonly WorkTableRow[],
): WorkInFlightCounts {
  const counts: WorkInFlightCounts = { ...ZERO_COUNTS };

  for (const { stage } of rows) {
    if (isWorkInFlight(stage)) counts[stage] += 1;
  }

  return counts;
}
