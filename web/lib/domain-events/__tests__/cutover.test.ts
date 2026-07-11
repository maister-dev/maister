import type { DomainEventRow } from "@/lib/db/schema";

import { describe, expect, it } from "vitest";

import {
  GRAPH_ONLY_CUTOVER_REASON,
  GRAPH_ONLY_CUTOVER_SOURCE,
  isGraphOnlyCutoverFailure,
} from "@/lib/domain-events/cutover";

function event(
  kind: DomainEventRow["kind"],
  payload: Record<string, unknown>,
): Pick<DomainEventRow, "kind" | "payload"> {
  return { kind, payload };
}

describe("isGraphOnlyCutoverFailure", () => {
  it.each([
    ["unrelated kind", event("run.done", {})],
    [
      "reason without source",
      event("run.failed", { reason: GRAPH_ONLY_CUTOVER_REASON }),
    ],
    [
      "source without reason",
      event("run.failed", { source: GRAPH_ONLY_CUTOVER_SOURCE }),
    ],
    [
      "ordinary CONFIG failure",
      event("run.failed", { reason: "CONFIG", source: "runner" }),
    ],
  ])("does not exclude %s", (_label, input) => {
    expect(isGraphOnlyCutoverFailure(input)).toBe(false);
  });

  it("matches only the durable reason/source pair on run.failed", () => {
    expect(
      isGraphOnlyCutoverFailure(
        event("run.failed", {
          reason: GRAPH_ONLY_CUTOVER_REASON,
          source: GRAPH_ONLY_CUTOVER_SOURCE,
        }),
      ),
    ).toBe(true);
  });
});
