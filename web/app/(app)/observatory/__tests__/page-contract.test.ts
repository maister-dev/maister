import { describe, expect, it } from "vitest";

import en from "@/messages/en.json";
import ru from "@/messages/ru.json";
import { parseObservatorySearchParams } from "@/lib/observatory/filters";
import {
  defaultObservatoryView,
  isObservatoryView,
  OBSERVATORY_VIEWS,
} from "@/lib/observatory/views";

const NOW = new Date("2026-06-05T12:00:00.000Z");

describe("observatory page contract", () => {
  it("parses bounded GET filters for portfolio and project routes", () => {
    const parsed = parseObservatorySearchParams(
      {
        artifactDefId: " junit ",
        artifactKind: " log ",
        flowId: " aif ",
        nodeId: ["checks"],
        runKind: "scratch",
        windowDays: "999",
      },
      NOW,
    );

    expect(parsed.filters).toEqual({
      artifactDefId: "junit",
      artifactKind: "log",
      flowId: "aif",
      nodeId: "checks",
      now: NOW,
      projectSlug: undefined,
      runKind: "scratch",
      since: new Date("2025-06-06T00:00:00.000Z"),
      until: new Date("2026-06-06T00:00:00.000Z"),
    });
    expect(parsed.current.artifactKind).toBe("log");
    // The 365-day clamp still holds, now as a day-aligned span.
    expect(parsed.current.period.windowDays).toBe(365);
  });

  // A repeated param takes its FIRST value, exactly like every other field
  // (`firstNonEmpty`). Resolving a repeated value to the default instead made
  // two fields disagree with the rest of the bar, and let a repeated `view`
  // defeat the drill-down default below — `parseView` returned a non-nullish
  // "overview", so `defaultObservatoryView` never ran.
  it("treats absent and invalid run-kind values as all, and a repeated one as its first", () => {
    expect(parseObservatorySearchParams({}).filters.runKind).toBe("all");
    expect(
      parseObservatorySearchParams({ runKind: ["scratch", "agent"] }).filters
        .runKind,
    ).toBe("scratch");
    expect(
      parseObservatorySearchParams({ runKind: ["bogus", "flow"] }).filters
        .runKind,
    ).toBe("all");
    expect(
      parseObservatorySearchParams({ runKind: "unknown" }).filters.runKind,
    ).toBe("all");
  });

  it("does not cast invalid artifact kind query values into DB filters", () => {
    const parsed = parseObservatorySearchParams({
      artifactKind: "not_a_kind",
    });

    expect(parsed.filters.artifactKind).toBeUndefined();
    expect(parsed.current.artifactKind).toBe("not_a_kind");
  });

  it("defaults the view to overview and narrows it to the allow-list", () => {
    expect(parseObservatorySearchParams({}, NOW).current.view).toBe("overview");
    expect(
      parseObservatorySearchParams({ view: "bogus" }, NOW).current.view,
    ).toBe("overview");
    // First value, like every other field.
    expect(
      parseObservatorySearchParams({ view: ["cost", "quality"] }, NOW).current
        .view,
    ).toBe("cost");

    for (const view of OBSERVATORY_VIEWS) {
      expect(parseObservatorySearchParams({ view }, NOW).current.view).toBe(
        view,
      );
    }
  });

  // The reason the short-circuit went: it resolved a repeated `view` to a
  // non-nullish "overview", which BOTH ignored the views actually asked for and
  // skipped `defaultObservatoryView` — landing a flow drill-down on a table its
  // filters do not touch.
  it("honours the first of a repeated view rather than resetting to overview", () => {
    expect(
      parseObservatorySearchParams(
        { flowId: "aif", view: ["quality", "cost"] },
        NOW,
      ).current.view,
    ).toBe("quality");
  });

  it("lands a flow-ledger drill-down link on quality when it names no view", () => {
    for (const params of [
      { flowId: "aif" },
      { nodeId: "checks" },
      { artifactKind: "log" },
      { artifactDefId: "junit" },
    ]) {
      expect(parseObservatorySearchParams(params, NOW).current.view).toBe(
        "quality",
      );
    }

    // An explicit view always wins over the drill-down default.
    expect(
      parseObservatorySearchParams({ nodeId: "checks", view: "cost" }, NOW)
        .current.view,
    ).toBe("cost");
  });

  it("classifies view values through one exported allow-list", () => {
    expect(OBSERVATORY_VIEWS).toEqual([
      "overview",
      "cost",
      "quality",
      "harness",
    ]);
    expect(isObservatoryView("quality")).toBe(true);
    expect(isObservatoryView("Quality")).toBe(false);
    expect(defaultObservatoryView({})).toBe("overview");
    expect(defaultObservatoryView({ nodeId: "checks" })).toBe("quality");
  });

  it("hands from/to to the period resolver and exposes the effective range", () => {
    const parsed = parseObservatorySearchParams(
      { from: "2026-05-01", to: "2026-05-31", windowDays: "7" },
      NOW,
    );

    expect(parsed.filters.since).toEqual(new Date("2026-05-01T00:00:00.000Z"));
    expect(parsed.filters.until).toEqual(new Date("2026-06-01T00:00:00.000Z"));
    expect(parsed.current.period.from).toBe("2026-05-01");
    expect(parsed.current.period.to).toBe("2026-05-31");
    expect(parsed.current.period.preset).toBeNull();
  });

  it("drops an inverted custom range back to the preset default", () => {
    const parsed = parseObservatorySearchParams(
      { from: "2026-05-31", to: "2026-05-01" },
      NOW,
    );

    expect(parsed.current.period.preset).toBe(30);
    expect(parsed.current.period.from).toBeUndefined();
    expect(parsed.filters.since).toEqual(new Date("2026-05-07T00:00:00.000Z"));
  });

  it("shares ONE now across filters.now, since and until", () => {
    const parsed = parseObservatorySearchParams({ windowDays: "7" }, NOW);

    expect(parsed.filters.now).toBe(NOW);
    expect(parsed.filters.until).toEqual(new Date("2026-06-06T00:00:00.000Z"));
    expect(parsed.filters.since).toEqual(new Date("2026-05-30T00:00:00.000Z"));
    expect(parsed.current.period.since).toEqual(parsed.filters.since);
    expect(parsed.current.period.until).toEqual(parsed.filters.until);
  });

  it("passes the project slug through untouched for server-side resolution", () => {
    expect(
      parseObservatorySearchParams({ project: " maister " }, NOW).current
        .project,
    ).toBe("maister");
    expect(
      parseObservatorySearchParams({ project: " maister " }, NOW).filters
        .projectSlug,
    ).toBe("maister");
    expect(
      parseObservatorySearchParams({}, NOW).current.project,
    ).toBeUndefined();
  });

  it("keeps EN and RU observatory message namespaces in parity", () => {
    expect(flatKeys(en.observatory).sort()).toEqual(
      flatKeys(ru.observatory).sort(),
    );
  });

  it("ships the harness section keys both pages render from", () => {
    const keys = flatKeys(en.observatory);

    for (const key of [
      "harness.sectionTitle",
      "harness.firingTitle",
      "harness.neverFired",
      "harness.coverageTitle",
      "harness.guidesWithoutSensors",
      "harness.effectivenessTitle",
      "harness.insufficientData",
    ]) {
      expect(keys).toContain(key);
    }
  });
});

function flatKeys(value: Record<string, unknown>, prefix = ""): string[] {
  return Object.entries(value).flatMap(([key, child]) =>
    child && typeof child === "object"
      ? flatKeys(child as Record<string, unknown>, `${prefix}${key}.`)
      : [`${prefix}${key}`],
  );
}
