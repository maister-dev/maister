import { describe, expect, it } from "vitest";

import { ALL_SCHEDULER_JOB_KINDS } from "@/lib/scheduler/job-catalog";
import en from "@/messages/en.json";
import ru from "@/messages/ru.json";

// ---------------------------------------------------------------------------
// CONTRACT under test — `adminScheduler.kind` label-map closure:
//   components/admin/scheduler-jobs-table.tsx renders t(`kind.${kind}`) for
//   EVERY kind in FILTERABLE_SCHEDULER_JOB_KINDS (= ALL_SCHEDULER_JOB_KINDS)
//   — in the kind filter select and on every job-row badge — and
//   scheduler-job-edit-modal.tsx does the same for creatable kinds. A kind
//   missing from the map renders the raw `adminScheduler.kind.<kind>`
//   fallback on the admin scheduler page (system-managed kinds included).
//
// The label map in BOTH locales must therefore stay exactly closed over
// ALL_SCHEDULER_JOB_KINDS — no missing kinds, no stale extras.
// ---------------------------------------------------------------------------

type Catalog = Record<string, Record<string, unknown>>;

function kindLabels(cat: Catalog): Record<string, unknown> {
  const ns = (cat.adminScheduler ?? {}) as Record<string, unknown>;

  return (ns.kind ?? {}) as Record<string, unknown>;
}

describe("i18n — adminScheduler.kind labels exist in EN", () => {
  const labels = kindLabels(en as unknown as Catalog);

  for (const kind of ALL_SCHEDULER_JOB_KINDS) {
    it(`en.adminScheduler.kind.${kind} is a non-empty string`, () => {
      expect(typeof labels[kind]).toBe("string");
      expect((labels[kind] as string).length).toBeGreaterThan(0);
    });
  }
});

describe("i18n — adminScheduler.kind labels exist in RU", () => {
  const labels = kindLabels(ru as unknown as Catalog);

  for (const kind of ALL_SCHEDULER_JOB_KINDS) {
    it(`ru.adminScheduler.kind.${kind} is a non-empty string`, () => {
      expect(typeof labels[kind]).toBe("string");
      expect((labels[kind] as string).length).toBeGreaterThan(0);
    });
  }
});

describe("i18n — adminScheduler.kind stays exactly closed over ALL_SCHEDULER_JOB_KINDS", () => {
  const expected = [...ALL_SCHEDULER_JOB_KINDS].sort();

  it("EN label keys match the kind catalog exactly (no missing, no stale)", () => {
    expect(Object.keys(kindLabels(en as unknown as Catalog)).sort()).toEqual(
      expected,
    );
  });

  it("RU label keys match the kind catalog exactly (no missing, no stale)", () => {
    expect(Object.keys(kindLabels(ru as unknown as Catalog)).sort()).toEqual(
      expected,
    );
  });
});
