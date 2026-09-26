import { describe, expect, it } from "vitest";

import {
  ACTIVE_RUN_STATUSES,
  RAIL_TTL_STATUSES,
} from "@/lib/queries/portfolio";

// ADR-181 D2 — `Failed` is a parked workbench. The array is consumed by the
// portfolio grid, the project workspace list, the left rail and the attention
// stream's change scan; this pin is the one place a regression shows up before
// a query does.
describe("ACTIVE_RUN_STATUSES", () => {
  it("lists Failed beside Crashed", () => {
    expect(ACTIVE_RUN_STATUSES).toContain("Crashed");
    expect(ACTIVE_RUN_STATUSES).toContain("Failed");
  });

  it("never gives Failed the terminal GC countdown", () => {
    expect(RAIL_TTL_STATUSES).not.toContain("Failed");
  });
});
