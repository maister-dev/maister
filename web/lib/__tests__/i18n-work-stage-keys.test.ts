import { describe, expect, it } from "vitest";

import en from "@/messages/en.json";
import ru from "@/messages/ru.json";
import { STAGE_REFINEMENTS } from "@/components/work/work-stage-chip";
import { WORK_STAGES } from "@/lib/work/stage";

// ---------------------------------------------------------------------------
// CONTRACT under test — STG-10.
//
// Every `WorkStage` member carries an EN and an RU label, and the two DIFFER.
// A byte-identical EN/RU pair is the signature of an untranslated key that was
// copied to satisfy a parity check, which is exactly what this milestone's
// "EN + RU in the task that adds the string" rule exists to prevent.
//
// The non-member keys are part of the same rendering contract: `blocked` labels
// the attribute that rides beside the stage (STG-05), `promotedResult` labels
// the result-only variant ADR-170 D3 refuses to collapse into a plain
// "Promoted", and the `run*` keys label the run-status refinement ADR-174
// `REQ-D8` moved into the chip when it removed the raw-enum column.
//
// The refinement keys are DERIVED from `STAGE_REFINEMENTS` rather than listed,
// so a sixth collapsed run status cannot be added to the code and quietly
// skipped here — it arrives in this list and immediately demands EN and RU copy.
// ---------------------------------------------------------------------------

const EXTRA_KEYS = [
  "blocked",
  "promotedResult",
  ...STAGE_REFINEMENTS.map((refinement) => `run${refinement}` as const),
] as const;

const REQUIRED_KEYS = [...WORK_STAGES, ...EXTRA_KEYS] as const;

type Catalog = Record<string, Record<string, unknown>>;

function ns(cat: Catalog): Record<string, unknown> {
  return (cat.workStage ?? {}) as Record<string, unknown>;
}

const enNs = ns(en as unknown as Catalog);
const ruNs = ns(ru as unknown as Catalog);

describe("UT-STG-10 i18n — every WorkStage member has an EN label", () => {
  for (const key of REQUIRED_KEYS) {
    it(`en.workStage.${key} is a non-empty string`, () => {
      expect(typeof enNs[key]).toBe("string");
      expect((enNs[key] as string).trim().length).toBeGreaterThan(0);
    });
  }
});

describe("UT-STG-10 i18n — every WorkStage member has an RU label", () => {
  for (const key of REQUIRED_KEYS) {
    it(`ru.workStage.${key} is a non-empty string`, () => {
      expect(typeof ruNs[key]).toBe("string");
      expect((ruNs[key] as string).trim().length).toBeGreaterThan(0);
    });
  }
});

describe("UT-STG-10 i18n — workStage EN and RU are translated, not duplicated", () => {
  for (const key of REQUIRED_KEYS) {
    it(`workStage.${key} differs between EN and RU`, () => {
      expect(ruNs[key]).not.toBe(enNs[key]);
    });
  }

  it("keeps the two catalogs in exact key parity", () => {
    expect(Object.keys(ruNs).sort()).toEqual(Object.keys(enNs).sort());
  });

  it("declares no label for a stage the vocabulary does not have", () => {
    const allowed = new Set<string>(REQUIRED_KEYS);
    const strays = Object.keys(enNs).filter((key) => !allowed.has(key));

    expect(strays).toEqual([]);
  });
});
