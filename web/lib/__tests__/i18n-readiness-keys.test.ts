import { describe, expect, it } from "vitest";

import en from "@/messages/en.json";
import ru from "@/messages/ru.json";

// ---------------------------------------------------------------------------
// CONTRACT under test — M15 readiness namespace parity.
//
// The `readiness` namespace is consumed by:
//   - app/(app)/runs/[runId]/page.tsx  (tReadiness — all 8 keys)
//   - components/board/board.tsx       (tReadiness — 6 state keys)
//   - components/portfolio/project-card.tsx (tReadiness — dynamic ReadinessState key)
//
// Required keys (EN + RU, identical key set):
//   readiness.summary        ("Readiness" heading)
//   readiness.reasons        ("Reasons" label)
//   readiness.ready          (ReadinessState)
//   readiness.blocked        (ReadinessState)
//   readiness.stale          (ReadinessState)
//   readiness.failed         (ReadinessState)
//   readiness.waiting        (ReadinessState)
//   readiness.overridden     (ReadinessState)
// ---------------------------------------------------------------------------

const READINESS_FRAMING_KEYS = ["summary", "reasons"] as const;

const READINESS_STATE_KEYS = [
  "ready",
  "blocked",
  "stale",
  "failed",
  "waiting",
  "overridden",
] as const;

const ALL_READINESS_KEYS = [
  ...READINESS_FRAMING_KEYS,
  ...READINESS_STATE_KEYS,
] as const;

type Catalog = Record<string, Record<string, unknown>>;

function readinessNs(cat: Catalog): Record<string, unknown> {
  return (cat.readiness ?? {}) as Record<string, unknown>;
}

describe("i18n — readiness namespace exists in EN", () => {
  const ns = readinessNs(en as unknown as Catalog);

  for (const key of ALL_READINESS_KEYS) {
    it(`en.readiness.${key} is a non-empty string`, () => {
      expect(typeof ns[key]).toBe("string");
      expect((ns[key] as string).length).toBeGreaterThan(0);
    });
  }
});

describe("i18n — readiness namespace exists in RU", () => {
  const ns = readinessNs(ru as unknown as Catalog);

  for (const key of ALL_READINESS_KEYS) {
    it(`ru.readiness.${key} is a non-empty string`, () => {
      expect(typeof ns[key]).toBe("string");
      expect((ns[key] as string).length).toBeGreaterThan(0);
    });
  }
});

describe("i18n — EN and RU `readiness` namespaces stay in key parity", () => {
  it("every EN readiness key exists in RU and vice versa (no missing translation)", () => {
    const enKeys = Object.keys(readinessNs(en as unknown as Catalog)).sort();
    const ruKeys = Object.keys(readinessNs(ru as unknown as Catalog)).sort();

    expect(ruKeys).toEqual(enKeys);
  });

  it("all 8 required readiness keys are present in BOTH catalogs", () => {
    const enKeys = new Set(Object.keys(readinessNs(en as unknown as Catalog)));
    const ruKeys = new Set(Object.keys(readinessNs(ru as unknown as Catalog)));
    const missingEn = ALL_READINESS_KEYS.filter((k) => !enKeys.has(k));
    const missingRu = ALL_READINESS_KEYS.filter((k) => !ruKeys.has(k));

    expect(missingEn).toEqual([]);
    expect(missingRu).toEqual([]);
  });

  it("the 6 ReadinessState keys are all present in EN", () => {
    const ns = readinessNs(en as unknown as Catalog);

    for (const key of READINESS_STATE_KEYS) {
      expect(typeof ns[key]).toBe("string");
    }
  });

  it("the 6 ReadinessState keys are all present in RU", () => {
    const ns = readinessNs(ru as unknown as Catalog);

    for (const key of READINESS_STATE_KEYS) {
      expect(typeof ns[key]).toBe("string");
    }
  });
});
