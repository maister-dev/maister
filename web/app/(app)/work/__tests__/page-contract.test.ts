// T3.3 — the `/work` page contract: bounded URL parsing, deterministic
// grouping, and EN/RU parity for the namespaces the route renders from.
//
// The route itself is exercised end-to-end by `E2E-STG-09`; what belongs here
// is everything that is a pure function of the query string, because that is
// where a silently-dropped filter or a nondeterministic group order hides.

import type { WorkTableRow } from "@/lib/queries/work-table";

import { describe, expect, it } from "vitest";

import en from "@/messages/en.json";
import ru from "@/messages/ru.json";
import { WORK_STAGES, type WorkStage } from "@/lib/work/stage";
import {
  filterWorkTableRows,
  groupWorkTableRows,
  normalizeWorkTableFilters,
  workAge,
  workNextAction,
  workTableFiltersToQuery,
} from "@/lib/work/work-table-view";

function row(overrides: Partial<WorkTableRow> = {}): WorkTableRow {
  return {
    taskId: `task-${overrides.keyRef ?? "AAA-1"}`,
    number: 1,
    keyRef: "AAA-1",
    title: "a task",
    projectId: "p1",
    projectSlug: "alpha",
    projectName: "Alpha",
    stage: "Ready",
    blocked: false,
    promotedKind: null,
    progress: null,
    runId: null,
    runStatus: null,
    readiness: null,
    waitingOn: null,
    blockers: [],
    tokens: 0,
    lastActivityAt: new Date("2026-09-10T10:00:00.000Z"),
    ...overrides,
  };
}

describe("work page contract — URL filters", () => {
  it("parses project, stage and group from the query string", () => {
    expect(
      normalizeWorkTableFilters({
        project: " alpha ",
        stage: "Executing",
        group: "project",
      }),
    ).toEqual({ projectSlug: "alpha", stage: "Executing", groupBy: "project" });
  });

  it("falls back to no filters and no grouping on an empty query", () => {
    expect(normalizeWorkTableFilters({})).toEqual({
      projectSlug: null,
      stage: null,
      groupBy: "none",
    });
  });

  it("does not cast an invalid stage into a filter", () => {
    expect(normalizeWorkTableFilters({ stage: "Shipping" }).stage).toBeNull();
  });

  it("ignores a repeated parameter rather than picking one arbitrarily", () => {
    expect(
      normalizeWorkTableFilters({ stage: ["Review", "Crashed"] }).stage,
    ).toBeNull();
  });

  it("falls back to no grouping for an unknown group value", () => {
    expect(normalizeWorkTableFilters({ group: "sideways" }).groupBy).toBe(
      "none",
    );
  });

  it("drops — never refuses — a project slug the reader cannot see", () => {
    const filters = normalizeWorkTableFilters({ project: "not-mine" });

    expect(filters.projectSlug).toBe("not-mine");
    expect(filterWorkTableRows([row()], filters)).toEqual([]);
  });

  it("round-trips filters back into a deep-linkable query string", () => {
    const filters = normalizeWorkTableFilters({
      project: "alpha",
      stage: "Review",
      group: "mine",
    });

    const query = workTableFiltersToQuery(filters);

    expect(query).toBe("project=alpha&stage=Review&group=mine");
    expect(
      normalizeWorkTableFilters(Object.fromEntries(new URLSearchParams(query))),
    ).toEqual(filters);
  });

  it("emits an empty query string when nothing is filtered", () => {
    expect(
      workTableFiltersToQuery({
        projectSlug: null,
        stage: null,
        groupBy: "none",
      }),
    ).toBe("");
  });
});

describe("work page contract — grouping", () => {
  const rows = [
    row({
      keyRef: "AAA-1",
      stage: "Review",
      projectSlug: "zeta",
      projectName: "Zeta",
    }),
    row({
      keyRef: "AAA-2",
      stage: "Ready",
      projectSlug: "alpha",
      projectName: "Alpha",
    }),
    row({
      keyRef: "AAA-3",
      stage: "Review",
      projectSlug: "alpha",
      projectName: "Alpha",
    }),
  ];

  it("returns one anonymous group when grouping is off", () => {
    const groups = groupWorkTableRows(rows, "none");

    expect(groups).toHaveLength(1);
    expect(groups[0].rows).toHaveLength(3);
  });

  it("orders stage groups by the declared lifecycle, not by arrival", () => {
    const groups = groupWorkTableRows(rows, "stage");

    expect(groups.map((group) => group.id)).toEqual(["Ready", "Review"]);
  });

  it("orders project groups alphabetically by name", () => {
    const groups = groupWorkTableRows(rows, "project");

    expect(groups.map((group) => group.id)).toEqual(["alpha", "zeta"]);
  });

  it("labels a project group by kind, so a project named for a stage keeps its own name", () => {
    const collision = row({
      keyRef: "AAA-9",
      projectSlug: "review",
      projectName: "Review",
    });
    const [group] = groupWorkTableRows([collision], "project");

    expect(group.kind).toBe("project");
    expect(group.label).toBe("Review");
  });

  it("splits 'mine' on who the row is actually waiting for", () => {
    const waiting = row({
      keyRef: "AAA-4",
      waitingOn: { kind: "you", name: null, since: new Date(0) },
    });
    const groups = groupWorkTableRows([...rows, waiting], "mine");

    expect(groups.map((group) => group.id)).toEqual(["mine", "others"]);
    expect(groups[0].rows).toHaveLength(1);
    expect(groups[1].rows).toHaveLength(3);
  });

  it("omits an empty half rather than rendering a heading over nothing", () => {
    expect(groupWorkTableRows(rows, "mine").map((g) => g.id)).toEqual([
      "others",
    ]);
  });

  it("loses no row under any grouping", () => {
    for (const groupBy of ["none", "project", "stage", "mine"] as const) {
      const total = groupWorkTableRows(rows, groupBy).reduce(
        (sum, group) => sum + group.rows.length,
        0,
      );

      expect(total).toBe(rows.length);
    }
  });
});

describe("work page contract — next action and age", () => {
  it("names a next action for every stage in the vocabulary", () => {
    for (const stage of WORK_STAGES) {
      expect(workNextAction(stage as WorkStage)).toBeTruthy();
    }
  });

  it("formats an age in the largest unit that fits", () => {
    const now = new Date("2026-09-10T12:00:00.000Z");

    expect(workAge(new Date("2026-09-10T11:56:00.000Z"), now)).toBe("4m");
    expect(workAge(new Date("2026-09-10T09:00:00.000Z"), now)).toBe("3h");
    expect(workAge(new Date("2026-09-04T12:00:00.000Z"), now)).toBe("6d");
  });

  it("clamps a future timestamp to zero rather than printing a negative age", () => {
    const now = new Date("2026-09-10T12:00:00.000Z");

    expect(workAge(new Date("2026-09-10T13:00:00.000Z"), now)).toBe("0m");
  });
});

describe("work page contract — i18n", () => {
  it("keeps the EN and RU work namespaces in parity", () => {
    expect(flatKeys(en.work).sort()).toEqual(flatKeys(ru.work).sort());
  });

  it("ships a rail label that is not the board's Activity tab label", () => {
    expect(en.nav.work).toBeTruthy();
    expect(ru.nav.work).toBeTruthy();
    expect(en.nav.work).not.toBe(en.nav.activity);
    expect(ru.nav.work).not.toBe(ru.nav.activity);
  });

  it("translates every column the table renders", () => {
    const keys = flatKeys(en.work);

    for (const column of [
      "key",
      "title",
      "project",
      "stage",
      "readiness",
      "waitingOn",
      "blockers",
      "tokens",
      "lastActivity",
      "nextAction",
    ]) {
      expect(keys).toContain(`columns.${column}`);
    }
  });

  // ADR-174 `REQ-D8`: the raw-enum column is gone and its key with it. A key
  // left behind is a string nobody renders — exactly the orphan class `T-D23`
  // exists to stop on the Desk side.
  it("no longer ships a run-status column label", () => {
    expect(flatKeys(en.work)).not.toContain("columns.run");
    expect(flatKeys(ru.work)).not.toContain("columns.run");
  });

  // And the refinement it carried has a home, in both locales.
  it("translates every run-status refinement the chip can show", () => {
    for (const key of [
      "runNeedsInput",
      "runNeedsInputIdle",
      "runHumanWorking",
      "runRunning",
      "runWaitingOnChildren",
    ]) {
      expect(en.workStage, key).toHaveProperty(key);
      expect(ru.workStage, key).toHaveProperty(key);
      expect(
        (en.workStage as Record<string, string>)[key],
        `${key} must differ from the RU copy`,
      ).not.toBe((ru.workStage as Record<string, string>)[key]);
    }
  });

  it("uses $count, never an ICU template, in the client-rendered row count", () => {
    expect(en.work.rowCount).toContain("$count");
    expect(ru.work.rowCount).toContain("$count");
    expect(en.work.rowCount).not.toContain("{count");
    expect(ru.work.rowCount).not.toContain("{count");
  });
});

function flatKeys(value: Record<string, unknown>, prefix = ""): string[] {
  return Object.entries(value).flatMap(([key, child]) =>
    child && typeof child === "object"
      ? flatKeys(child as Record<string, unknown>, `${prefix}${key}.`)
      : [`${prefix}${key}`],
  );
}
