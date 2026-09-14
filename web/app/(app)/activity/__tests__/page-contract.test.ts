// T5.3 — the `/activity` page contract: bounded URL parsing, the read-cursor
// divider, and EN/RU parity for the namespace the route renders from.
//
// Everything here is a pure function of the query string or of already-fetched
// rows. `IT-ATN-10` owns the cursor write; this owns what the page does with
// the cursor once it has it.

import type { ActivityFeedRow } from "@/lib/queries/activity-feed";

import { describe, expect, it } from "vitest";

import en from "@/messages/en.json";
import ru from "@/messages/ru.json";
import {
  ACTIVITY_ACTOR_TYPES,
  ACTIVITY_FEED_KINDS,
  ACTIVITY_WEBHOOK_KINDS,
  isActivityFeedKind,
} from "@/lib/queries/activity-feed";
import {
  activityFiltersToQuery,
  activityKindKey,
  normalizeActivityFilters,
  splitAtCursor,
} from "@/lib/activity/activity-view";

function row(at: string, overrides: Partial<ActivityFeedRow> = {}) {
  return {
    id: `task:${at}`,
    source: "task",
    kind: "comment_added",
    occurredAt: new Date(at),
    projectId: "p1",
    projectSlug: "alpha",
    projectName: "Alpha",
    actor: { type: "user", id: "u1", label: "Ann" },
    taskId: "t1",
    taskKey: "AAA-1",
    taskNumber: 1,
    taskTitle: "a task",
    runId: null,
    gateId: null,
    hitlRequestId: null,
    webhook: null,
    ...overrides,
  } as ActivityFeedRow;
}

describe("activity page contract — URL filters", () => {
  it("parses project, actor, kind and mine from the query string", () => {
    expect(
      normalizeActivityFilters({
        project: " alpha ",
        actor: "agent",
        kind: "run.done",
        mine: "1",
      }),
    ).toEqual({
      projectSlug: "alpha",
      actorType: "agent",
      kind: "run.done",
      mine: true,
    });
  });

  it("falls back to no filters on an empty query", () => {
    expect(normalizeActivityFilters({})).toEqual({
      projectSlug: null,
      actorType: null,
      kind: null,
      mine: false,
    });
  });

  it("does not cast an invalid kind or actor into a filter", () => {
    const filters = normalizeActivityFilters({
      kind: "run.exploded",
      actor: "robot",
    });

    expect(filters.kind).toBeNull();
    expect(filters.actorType).toBeNull();
  });

  it("ignores a repeated parameter rather than picking one arbitrarily", () => {
    expect(
      normalizeActivityFilters({ kind: ["run.done", "run.failed"] }).kind,
    ).toBeNull();
  });

  it("treats any value but 1 as not-mine", () => {
    expect(normalizeActivityFilters({ mine: "true" }).mine).toBe(false);
    expect(normalizeActivityFilters({ mine: "1" }).mine).toBe(true);
  });

  it("echoes an unknown project slug so the page can drop it, not refuse it", () => {
    expect(normalizeActivityFilters({ project: "not-mine" }).projectSlug).toBe(
      "not-mine",
    );
  });

  it("round-trips filters back into a deep-linkable query string", () => {
    const filters = normalizeActivityFilters({
      project: "alpha",
      actor: "system",
      kind: "gate.failed",
      mine: "1",
    });
    const query = activityFiltersToQuery(filters);

    expect(query).toBe("project=alpha&actor=system&kind=gate.failed&mine=1");
    expect(
      normalizeActivityFilters(Object.fromEntries(new URLSearchParams(query))),
    ).toEqual(filters);
  });

  it("emits an empty query string when nothing is filtered", () => {
    expect(
      activityFiltersToQuery({
        projectSlug: null,
        actorType: null,
        kind: null,
        mine: false,
      }),
    ).toBe("");
  });

  it("accepts every kind the feed can emit", () => {
    for (const kind of ACTIVITY_FEED_KINDS) {
      expect(isActivityFeedKind(kind)).toBe(true);
      expect(normalizeActivityFilters({ kind }).kind).toBe(kind);
    }
  });
});

describe("UT-EDGE-ATN-01 the unread divider", () => {
  const rows = [
    row("2026-09-10T12:00:00.000Z"),
    row("2026-09-10T11:00:00.000Z"),
    row("2026-09-10T10:00:00.000Z"),
  ];

  it("splits on the cursor, newest above", () => {
    const split = splitAtCursor(rows, new Date("2026-09-10T10:30:00.000Z"));

    expect(split.unread).toHaveLength(2);
    expect(split.seen).toHaveLength(1);
    expect(split.divider).toBe(true);
  });

  // EDGE-ATN-01: no cursor row means "never looked". A divider above every row
  // would claim everything is new, when the truth is that nothing is known.
  it("draws no divider when the reader has never looked", () => {
    const split = splitAtCursor(rows, null);

    expect(split.unread).toEqual([]);
    expect(split.seen).toHaveLength(3);
    expect(split.divider).toBe(false);
  });

  it("draws no divider when everything is already seen", () => {
    const split = splitAtCursor(rows, new Date("2026-09-10T13:00:00.000Z"));

    expect(split.unread).toEqual([]);
    expect(split.divider).toBe(false);
  });

  it("draws no divider when everything is unread", () => {
    const split = splitAtCursor(rows, new Date("2026-09-10T09:00:00.000Z"));

    expect(split.unread).toHaveLength(3);
    expect(split.divider).toBe(false);
  });

  it("treats a row exactly at the cursor as already seen", () => {
    const split = splitAtCursor(rows, new Date("2026-09-10T11:00:00.000Z"));

    expect(split.unread.map((r) => r.occurredAt.toISOString())).toEqual([
      "2026-09-10T12:00:00.000Z",
    ]);
    expect(split.seen).toHaveLength(2);
  });

  it("loses no row at any cursor position", () => {
    for (const cursor of [
      null,
      new Date("2026-09-10T09:00:00.000Z"),
      new Date("2026-09-10T11:00:00.000Z"),
      new Date("2026-09-10T13:00:00.000Z"),
    ]) {
      const split = splitAtCursor(rows, cursor);

      expect(split.unread.length + split.seen.length).toBe(rows.length);
    }
  });
});

describe("activity page contract — i18n", () => {
  it("keeps the EN and RU activityFeed namespaces in parity", () => {
    expect(flatKeys(en.activityFeed).sort()).toEqual(
      flatKeys(ru.activityFeed).sort(),
    );
  });

  it("labels every kind the feed can emit, in both locales", () => {
    for (const kind of ACTIVITY_FEED_KINDS) {
      const key = activityKindKey(kind);

      expect(
        (en.activityFeed.kinds as Record<string, string>)[key],
        `EN label for ${kind}`,
      ).toBeTruthy();
      expect(
        (ru.activityFeed.kinds as Record<string, string>)[key],
        `RU label for ${kind}`,
      ).toBeTruthy();
    }
  });

  it("labels every actor type in both locales", () => {
    for (const actorType of ACTIVITY_ACTOR_TYPES) {
      expect(
        (en.activityFeed.actor as Record<string, string>)[actorType],
      ).toBeTruthy();
      expect(
        (ru.activityFeed.actor as Record<string, string>)[actorType],
      ).toBeTruthy();
    }
  });

  // The kind ids carry dots; next-intl reads a dot as a namespace separator, so
  // `kinds.run.done` would look for a `run` object that is not there.
  it("keys the catalogs on a dot-free form", () => {
    for (const key of Object.keys(en.activityFeed.kinds)) {
      expect(key).not.toContain(".");
    }
    expect(activityKindKey("run.done")).toBe("run_done");
  });

  it("ships a rail label of its own, not the board's Activity tab key", () => {
    expect(en.nav.activityFeed).toBeTruthy();
    expect(ru.nav.activityFeed).toBeTruthy();
    expect(Object.keys(en.nav)).toContain("activity");
  });

  it("uses $count, never an ICU template, in the client-rendered counts", () => {
    for (const template of [
      en.activityFeed.rowCount,
      ru.activityFeed.rowCount,
      en.activityFeed.latestOnly,
      ru.activityFeed.latestOnly,
      en.activityFeed.webhookAttempts,
      ru.activityFeed.webhookAttempts,
    ]) {
      expect(template).toContain("$count");
      expect(template).not.toContain("{count");
    }
  });

  it("names both webhook outcomes distinctly", () => {
    const labels = ACTIVITY_WEBHOOK_KINDS.map(
      (kind) =>
        (en.activityFeed.kinds as Record<string, string>)[
          activityKindKey(kind)
        ],
    );

    expect(new Set(labels).size).toBe(ACTIVITY_WEBHOOK_KINDS.length);
  });
});

function flatKeys(value: Record<string, unknown>, prefix = ""): string[] {
  return Object.entries(value).flatMap(([key, child]) =>
    child && typeof child === "object"
      ? flatKeys(child as Record<string, unknown>, `${prefix}${key}.`)
      : [`${prefix}${key}`],
  );
}
