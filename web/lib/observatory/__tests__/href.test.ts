import { describe, expect, it } from "vitest";

import { parseObservatorySearchParams } from "@/lib/observatory/filters";
import {
  buildObservatoryHref,
  observatoryDrilldownHref,
  observatoryViewHref,
} from "@/lib/observatory/href";
import {
  periodToLedgerDates,
  runsLedgerHref,
} from "@/lib/observatory/drilldown";

const NOW = new Date("2026-06-05T12:00:00.000Z");

function current(params: Record<string, string> = {}) {
  return parseObservatorySearchParams(params, NOW).current;
}

describe("buildObservatoryHref (ADR-177 D7)", () => {
  it("serializes the effective period as a preset", () => {
    expect(buildObservatoryHref("/observatory", current())).toBe(
      "/observatory?view=overview&windowDays=30",
    );
  });

  it("serializes a custom range as from/to and drops windowDays", () => {
    expect(
      buildObservatoryHref(
        "/observatory",
        current({ from: "2026-05-01", to: "2026-05-31", windowDays: "7" }),
      ),
    ).toBe("/observatory?view=overview&from=2026-05-01&to=2026-05-31");
  });

  it("switching to a preset drops the custom range", () => {
    expect(
      buildObservatoryHref(
        "/observatory",
        current({ from: "2026-05-01", to: "2026-05-31" }),
        { windowDays: 7 },
      ),
    ).toBe("/observatory?view=overview&windowDays=7");
  });

  it("keeps the preset until BOTH custom bounds are present", () => {
    expect(
      buildObservatoryHref("/observatory", current(), { from: "2026-05-01" }),
    ).toBe("/observatory?view=overview&windowDays=30");
    expect(
      buildObservatoryHref("/observatory", current(), {
        from: "2026-05-01",
        to: "2026-05-31",
      }),
    ).toBe("/observatory?view=overview&from=2026-05-01&to=2026-05-31");
  });

  it("omits runKind=all and emits a narrowed kind", () => {
    expect(buildObservatoryHref("/observatory", current())).not.toContain(
      "runKind",
    );
    expect(
      buildObservatoryHref("/observatory", current(), { runKind: "scratch" }),
    ).toBe("/observatory?view=overview&windowDays=30&runKind=scratch");
    expect(
      buildObservatoryHref("/observatory", current({ runKind: "scratch" }), {
        runKind: "all",
      }),
    ).toBe("/observatory?view=overview&windowDays=30");
  });

  it("clearing a field removes its param", () => {
    const withProject = current({ project: "maister", nodeId: "checks" });

    expect(
      buildObservatoryHref("/observatory", withProject, { project: null }),
    ).toBe("/observatory?view=quality&windowDays=30&nodeId=checks");
    expect(
      buildObservatoryHref("/observatory", withProject, { nodeId: null }),
    ).toBe("/observatory?view=quality&windowDays=30&project=maister");
  });

  it("preserves the view across an unrelated change", () => {
    expect(
      buildObservatoryHref("/observatory", current({ view: "cost" }), {
        runKind: "agent",
      }),
    ).toBe("/observatory?view=cost&windowDays=30&runKind=agent");
  });

  it("works on the project route pathname too", () => {
    expect(
      buildObservatoryHref("/projects/maister/observatory", current()),
    ).toBe("/projects/maister/observatory?view=overview&windowDays=30");
  });
});

describe("observatoryViewHref (ADR-177 D6)", () => {
  const drilled = () =>
    current({
      nodeId: "checks",
      flowId: "aif",
      artifactKind: "log",
      artifactDefId: "junit",
      runKind: "flow",
    });

  it("keeps every drill-down key on Quality, which owns them all", () => {
    const href = observatoryViewHref("/observatory", drilled(), "quality");

    expect(href).toContain("view=quality");
    expect(href).toContain("flowId=aif");
    expect(href).toContain("nodeId=checks");
    expect(href).toContain("artifactKind=log");
    expect(href).toContain("artifactDefId=junit");
  });

  // D7 gives Harness flow and node but NOT the artifact pair, and its bar
  // renders no artifact control. Carrying them over made the harness metrics
  // narrow by an artifact the reader could neither see nor clear.
  it("drops the artifact pair on the way to Harness and keeps flow and node", () => {
    expect(observatoryViewHref("/observatory", drilled(), "harness")).toBe(
      "/observatory?view=harness&windowDays=30&runKind=flow&flowId=aif&nodeId=checks",
    );
  });

  it("drops them when leaving for Overview or Cost", () => {
    for (const view of ["overview", "cost"] as const) {
      const href = observatoryViewHref("/observatory", drilled(), view);

      expect(href).toBe(`/observatory?view=${view}&windowDays=30&runKind=flow`);
    }
  });

  it("preserves the period, run kind and project on every tab", () => {
    const state = current({
      from: "2026-05-01",
      to: "2026-05-31",
      runKind: "agent",
      project: "maister",
    });

    expect(observatoryViewHref("/observatory", state, "cost")).toBe(
      "/observatory?view=cost&from=2026-05-01&to=2026-05-31&runKind=agent&project=maister",
    );
  });
});

describe("observatoryDrilldownHref", () => {
  it("lands a heatmap cell on Quality carrying the period", () => {
    expect(
      observatoryDrilldownHref("/projects/maister/observatory", {
        period: current().period,
        runKind: "flow",
        flowId: "aif",
        nodeId: "checks",
      }),
    ).toBe(
      "/projects/maister/observatory?view=quality&windowDays=30&runKind=flow&flowId=aif&nodeId=checks",
    );
  });

  it("carries a custom range as from/to", () => {
    expect(
      observatoryDrilldownHref("/projects/maister/observatory", {
        period: current({ from: "2026-05-01", to: "2026-05-31" }).period,
        nodeId: "checks",
      }),
    ).toBe(
      "/projects/maister/observatory?view=quality&from=2026-05-01&to=2026-05-31&nodeId=checks",
    );
  });
});

describe("runsLedgerHref (ADR-177 D8)", () => {
  it("translates the half-open period into the ledger's inclusive day pair", () => {
    expect(periodToLedgerDates(current().period)).toEqual({
      from: "2026-05-07",
      to: "2026-06-05",
    });
    expect(
      periodToLedgerDates(
        current({ from: "2026-05-01", to: "2026-05-31" }).period,
      ),
    ).toEqual({ from: "2026-05-01", to: "2026-05-31" });
  });

  it("builds a cell link with project, kind, bucket and the day bounds", () => {
    expect(
      runsLedgerHref({
        projectSlug: "maister",
        period: current().period,
        kind: "flow",
        bucket: "Delivered",
      }),
    ).toBe(
      "/runs?project=maister&kind=flow&bucket=Delivered&from=2026-05-07&to=2026-06-05",
    );
  });

  it("omits project, kind and bucket when the cell does not narrow them", () => {
    expect(runsLedgerHref({ period: current().period })).toBe(
      "/runs?from=2026-05-07&to=2026-06-05",
    );
  });

  it("uses the param names the ledger itself parses", async () => {
    const { normalizeRunsListFilters } = await import(
      "@/lib/queries/runs-list"
    );
    const href = runsLedgerHref({
      projectSlug: "maister",
      period: current().period,
      kind: "scratch",
      bucket: "Abandoned",
    });
    const query = Object.fromEntries(
      new URLSearchParams(href.split("?")[1] ?? ""),
    );

    expect(normalizeRunsListFilters(query)).toEqual({
      page: 1,
      projectSlug: "maister",
      kind: "scratch",
      bucket: "Abandoned",
      dateFrom: "2026-05-07",
      dateTo: "2026-06-05",
    });
  });
});

// The tab href is only half the guard: a bookmark, a pasted link or a hand-
// written URL never went through it. `parseObservatorySearchParams` is where
// BOTH the applied filters and the rendered controls are derived, so a param
// the view does not own has to die there.
describe("view field ownership at parse (ADR-177 D7)", () => {
  it("drops the artifact pair on Harness — no control renders it there", () => {
    const parsed = parseObservatorySearchParams(
      {
        view: "harness",
        flowId: "aif",
        nodeId: "checks",
        artifactKind: "log",
        artifactDefId: "junit",
      },
      NOW,
    );

    expect(parsed.filters.artifactKind).toBeUndefined();
    expect(parsed.filters.artifactDefId).toBeUndefined();
    expect(parsed.current.artifactKind).toBeUndefined();
    expect(parsed.current.artifactDefId).toBeUndefined();
    // Flow and node ARE harness fields and stay applied.
    expect(parsed.filters.flowId).toBe("aif");
    expect(parsed.filters.nodeId).toBe("checks");
  });

  it("drops all four on Overview and Cost, which own none of them", () => {
    for (const view of ["overview", "cost"] as const) {
      const { filters, current } = parseObservatorySearchParams(
        {
          view,
          flowId: "aif",
          nodeId: "checks",
          artifactKind: "log",
          artifactDefId: "junit",
        },
        NOW,
      );

      expect(filters.flowId).toBeUndefined();
      expect(filters.nodeId).toBeUndefined();
      expect(filters.artifactKind).toBeUndefined();
      expect(filters.artifactDefId).toBeUndefined();
      expect(current.flowId).toBeUndefined();
    }
  });

  it("keeps all four on Quality", () => {
    const { filters } = parseObservatorySearchParams(
      {
        view: "quality",
        flowId: "aif",
        nodeId: "checks",
        artifactKind: "log",
        artifactDefId: "junit",
      },
      NOW,
    );

    expect(filters).toMatchObject({
      flowId: "aif",
      nodeId: "checks",
      artifactKind: "log",
      artifactDefId: "junit",
    });
  });

  // D6's default is read from the RAW keys: a pre-view drill-down link carries
  // an artifact key with no `view=` and must still land on Quality holding it.
  it("still defaults a bare artifact link to Quality and keeps the key", () => {
    const { current, filters } = parseObservatorySearchParams(
      { artifactDefId: "junit" },
      NOW,
    );

    expect(current.view).toBe("quality");
    expect(filters.artifactDefId).toBe("junit");
  });

  it("re-serializes a Harness URL without the dropped params", () => {
    const { current } = parseObservatorySearchParams(
      { view: "harness", nodeId: "checks", artifactDefId: "junit" },
      NOW,
    );

    expect(buildObservatoryHref("/observatory", current)).toBe(
      "/observatory?view=harness&windowDays=30&nodeId=checks",
    );
  });
});
