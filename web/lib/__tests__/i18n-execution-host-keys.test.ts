import { describe, expect, it } from "vitest";

import en from "@/messages/en.json";
import ru from "@/messages/ru.json";
import { EXECUTION_HOST_READINESS } from "@/lib/execution-host/types";
import { RUNTIME_EVENT_CLOSE_REASONS } from "@/types/platform-status";

// ---------------------------------------------------------------------------
// CONTRACT under test — the admin execution-host view renders enum MEMBERS,
// and every member must resolve to localized copy in BOTH catalogs. A RU user
// must never read `poisoned` or `fallback_timer`.
//
// The value spaces are taken from their owning TYPE where one is exported, so
// adding an enum member fails this test rather than silently shipping the raw
// token to the page.
// ---------------------------------------------------------------------------

const STREAM_STATES = ["observed", "active", "closed", "lost"] as const;
const TELEMETRY_STATUSES = [
  "available",
  "unsupported",
  "unavailable",
  "stale",
] as const;
const CONSUMER_STATES = ["ready", "retrying", "poisoned"] as const;
const WORKER_STATES = ["running", "degraded", "stopped"] as const;
const VERDICTS = [
  "observing",
  "lagging",
  "not_advancing",
  "clear",
  "unknown",
  "inactive",
  "reset",
] as const;
const DRIVERS = ["fallback_timer", "external_tick", "missing_tick"] as const;
const JOB_STATUSES = [
  "Claimed",
  "Running",
  "Succeeded",
  "Failed",
  "Skipped",
] as const;

const HOST_SPAN_KEYS = [
  "hostSpanUnconfirmed",
  "hostSpanSettled1h",
  "postHocConflicts",
] as const;
// Each count's label names its window: the component supplies these values.
const WINDOWS = {
  hostSpanUnconfirmed: "days",
  hostSpanSettled1h: "hours",
  postHocConflicts: "days",
} as const;

type Catalog = Record<string, Record<string, unknown>>;

function ns(
  catalog: unknown,
  path: readonly string[],
): Record<string, unknown> {
  let value = catalog as Record<string, unknown>;

  for (const segment of path) {
    value = (value?.[segment] ?? {}) as Record<string, unknown>;
  }

  return value;
}

const GROUPS: ReadonlyArray<readonly [readonly string[], readonly string[]]> = [
  [["adminExecutionHost", "readiness"], EXECUTION_HOST_READINESS],
  [["adminExecutionHost", "streamState"], STREAM_STATES],
  [["adminExecutionHost", "telemetryStatus"], TELEMETRY_STATUSES],
  [["adminExecutionHost", "consumerState"], CONSUMER_STATES],
  [["adminExecutionHost", "workerState"], WORKER_STATES],
  [["adminExecutionHost", "verdict"], VERDICTS],
  [["adminExecutionHost", "driver"], DRIVERS],
  // ADR-167 amendment 2026-09-25: the host's subscriber close reasons.
  [["adminExecutionHost", "closeReason"], RUNTIME_EVENT_CLOSE_REASONS],
  // ADR-167 D5 amendment: the per-host host-span settlement counts.
  [["adminExecutionHost", "fields"], HOST_SPAN_KEYS],
  [["adminExecutionHost", "hostSpanHelp"], HOST_SPAN_KEYS],
  [
    ["adminExecutionHost", "commands"],
    ["hostSpan", "hostSpanEmpty"],
  ],
  [["adminScheduler", "clockCard", "jobStatus"], JOB_STATUSES],
];

describe("i18n — every rendered execution-host enum member has copy", () => {
  for (const [path, members] of GROUPS) {
    const label = path.join(".");

    for (const catalogName of ["en", "ru"] as const) {
      const catalog = catalogName === "en" ? en : ru;

      it(`${catalogName}.${label} covers every member`, () => {
        const group = ns(catalog as unknown as Catalog, path);

        for (const member of members) {
          expect(
            typeof group[member],
            `${catalogName}.${label}.${member}`,
          ).toBe("string");
          expect((group[member] as string).length).toBeGreaterThan(0);
        }
      });
    }

    it(`${label} keys are identical in EN and RU`, () => {
      expect(Object.keys(ns(ru as unknown as Catalog, path)).sort()).toEqual(
        Object.keys(ns(en as unknown as Catalog, path)).sort(),
      );
    });
  }

  // The window and host name are interpolated; a placeholder missing from one
  // catalog silently drops the count's window from that locale's label.
  it("host-span copy carries the same placeholders in EN and RU", () => {
    const placeholders = (value: unknown) =>
      [...String(value).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

    for (const [path, keys, expected] of [
      [["adminExecutionHost", "fields"], HOST_SPAN_KEYS, WINDOWS],
      [["adminExecutionHost", "hostSpanHelp"], HOST_SPAN_KEYS, null],
      [["adminExecutionHost", "commands"], ["hostSpan", "hostSpanEmpty"], null],
    ] as const) {
      for (const key of keys) {
        const enValue = ns(en as unknown as Catalog, path)[key];
        const ruValue = ns(ru as unknown as Catalog, path)[key];

        expect(placeholders(ruValue), `${path.join(".")}.${key}`).toEqual(
          placeholders(enValue),
        );
        if (expected !== null)
          expect(placeholders(enValue), `${path.join(".")}.${key}`).toEqual([
            expected[key as keyof typeof expected],
          ]);
      }
    }
  });

  it("RU never ships the EN string for a status word", () => {
    for (const [path] of GROUPS) {
      const enGroup = ns(en as unknown as Catalog, path);
      const ruGroup = ns(ru as unknown as Catalog, path);

      for (const [key, value] of Object.entries(ruGroup)) {
        // Latin-only RU copy means the English label was left in place.
        expect(
          /[А-Яа-яЁё]/.test(value as string),
          `${path.join(".")}.${key} = ${String(value)}`,
        ).toBe(true);
        expect(value).not.toBe(enGroup[key]);
      }
    }
  });
});
