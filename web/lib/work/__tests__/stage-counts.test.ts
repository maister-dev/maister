// `T-D1` (`AC-D1`) — the Now strip and the work table are ONE population.
//
// The strip summarizes the rows the table renders, so its counts come from that
// same array rather than from a query of their own (`REQ-D2`). Two properties
// carry the contract, and neither is provable by rendering:
//
//   1. the map's keys are exactly the in-flight partition, in its declared
//      order, so a tile can never appear or vanish under the reader (`REQ-D1`);
//   2. the values sum to EVERY row given — including the ones the Desk slices
//      away — which is what stops the strip from silently describing only the
//      visible page.

import type { WorkTableRow } from "@/lib/queries/work-table";
import type { WorkStage } from "@/lib/work/stage";

import { describe, expect, it } from "vitest";

import { countWorkInFlightByStage } from "@/lib/work/stage-counts";
import { WORK_IN_FLIGHT_STAGES } from "@/lib/work/stage";

function row(stage: WorkStage, index: number): WorkTableRow {
  return {
    taskId: `task-${index}`,
    number: index,
    keyRef: `MYAPP-${index}`,
    title: `task ${index}`,
    projectId: "project-1",
    projectSlug: "myapp",
    projectName: "MyApp",
    stage,
    blocked: false,
    promotedKind: null,
    progress: null,
    runId: `run-${index}`,
    runStatus: null,
    readiness: null,
    waitingOn: null,
    blockers: [],
    tokens: 0,
    lastActivityAt: new Date("2026-09-17T00:00:00.000Z"),
  };
}

function rowsOf(...stages: readonly WorkStage[]): WorkTableRow[] {
  return stages.map((stage, index) => row(stage, index));
}

function total(counts: Record<string, number>): number {
  return Object.values(counts).reduce((sum, value) => sum + value, 0);
}

describe("countWorkInFlightByStage", () => {
  it("carries exactly the five in-flight stages, in their declared order", () => {
    expect(Object.keys(countWorkInFlightByStage([]))).toEqual([
      ...WORK_IN_FLIGHT_STAGES,
    ]);
  });

  it("reports zero for an unoccupied stage rather than omitting it", () => {
    // REQ-D1: all five tiles render at zero. A map that omits empty stages
    // produces a strip whose tiles move as work arrives, destroying the fixed
    // positions a reader scans by.
    expect(countWorkInFlightByStage(rowsOf("Executing"))).toEqual({
      Queued: 0,
      Executing: 1,
      WaitingOnHuman: 0,
      Review: 0,
      Crashed: 0,
    });
  });

  it("counts each stage and sums to the number of rows given", () => {
    const rows = rowsOf(
      "Executing",
      "Executing",
      "WaitingOnHuman",
      "Review",
      "Crashed",
      "Queued",
      "Executing",
    );
    const counts = countWorkInFlightByStage(rows);

    expect(counts).toEqual({
      Queued: 1,
      Executing: 3,
      WaitingOnHuman: 1,
      Review: 1,
      Crashed: 1,
    });
    expect(total(counts)).toBe(rows.length);
  });

  it("sums to the total for a row set larger than the Desk's slice", () => {
    // `DESK_WORK_ROWS` is 12. Counting AFTER the slice is the plausible-looking
    // bug this case exists to catch: the strip would then answer "what is on
    // this page" while claiming to answer "what is in flight".
    const rows = Array.from({ length: 40 }, (_, index) =>
      row(WORK_IN_FLIGHT_STAGES[index % WORK_IN_FLIGHT_STAGES.length], index),
    );
    const counts = countWorkInFlightByStage(rows);

    expect(total(counts)).toBe(40);
    expect(counts.Queued).toBe(8);
  });
});
