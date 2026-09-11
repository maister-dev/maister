// `UT-STG-11` — the Desk's "work in flight" is a partition of the whole
// vocabulary, not a hand-picked subset.
//
// ADR-169 made a twelfth run status a compile error. This does the same job one
// level up: an eleventh WORK STAGE that nobody classifies would quietly fall out
// of the Desk's Work region — or quietly into it — and neither shows up as a
// failure anywhere else.

import { describe, expect, it } from "vitest";

import {
  isWorkInFlight,
  WORK_BACKLOG_STAGES,
  WORK_IN_FLIGHT_STAGES,
  WORK_SETTLED_STAGES,
  WORK_STAGES,
} from "@/lib/work/stage";

describe("UT-STG-11 the work-stage partition", () => {
  it("covers every stage exactly once", () => {
    const partitioned = [
      ...WORK_BACKLOG_STAGES,
      ...WORK_IN_FLIGHT_STAGES,
      ...WORK_SETTLED_STAGES,
    ];

    expect([...partitioned].sort()).toEqual([...WORK_STAGES].sort());
    expect(new Set(partitioned).size).toBe(WORK_STAGES.length);
  });

  it("calls exactly the launched-but-unsettled stages in flight", () => {
    expect(WORK_STAGES.filter(isWorkInFlight)).toEqual([
      "Queued",
      "Executing",
      "WaitingOnHuman",
      "Review",
      "Crashed",
    ]);
  });

  it("keeps unlaunched and finished work out of flight", () => {
    for (const stage of [...WORK_BACKLOG_STAGES, ...WORK_SETTLED_STAGES]) {
      expect(isWorkInFlight(stage), stage).toBe(false);
    }
  });
});
