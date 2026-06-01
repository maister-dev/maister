import { describe, expect, it } from "vitest";

import en from "@/messages/en.json";
import ru from "@/messages/ru.json";

// ---------------------------------------------------------------------------
// CONTRACT under test — M11c Phase 4.2 i18n keys for the run-detail
// settings-visibility panel + the board refused-indicator.
//
// Namespace decision: the run-detail panel keys live under the EXISTING `run`
// namespace (alongside the timeline/HITL run-detail strings). The top-level
// `settings` namespace is already owned by the instance-config (host roots /
// host tools) page and is NOT reused here.
//
// Required keys under `run` (EN + RU, identical key set):
//   Verdict labels:
//     run.settingsVerdictEnforced
//     run.settingsVerdictInstructed
//     run.settingsVerdictRefused
//   Capability-class labels (all 6 classes):
//     run.settingsClassMcps
//     run.settingsClassTools
//     run.settingsClassSkills
//     run.settingsClassRestrictions
//     run.settingsClassPermissionMode
//     run.settingsClassWorkspaceAccess
//   Panel framing + refusal:
//     run.settingsTitle                 (panel heading)
//     run.settingsNoConstraints         (node with classes: [])
//     run.settingsRefusalReason         (refusal-reason line for a refused run)
//   Board card refused indicator (Phase 4.3):
//     run.settingsRefusedHint           (the card hint/aria-label)
//
// The board hint may alternatively be placed in the `board` namespace; if the
// implementor puts it there, update the BOARD_KEYS list below to match. Until
// then this test is RED because none of these keys exist yet.
// ---------------------------------------------------------------------------

const RUN_SETTINGS_KEYS = [
  "settingsTitle",
  "settingsDeclaredIntentNote",
  "settingsVerdictEnforced",
  "settingsVerdictInstructed",
  "settingsVerdictRefused",
  "settingsClassMcps",
  "settingsClassTools",
  "settingsClassSkills",
  "settingsClassRestrictions",
  "settingsClassPermissionMode",
  "settingsClassWorkspaceAccess",
  "settingsNoConstraints",
  "settingsRefusalReason",
  "settingsRefusedHint",
] as const;

type Catalog = Record<string, Record<string, unknown>>;

function runNs(cat: Catalog): Record<string, unknown> {
  return (cat.run ?? {}) as Record<string, unknown>;
}

describe("i18n — M11c settings-panel keys exist in EN", () => {
  const ns = runNs(en as unknown as Catalog);

  for (const key of RUN_SETTINGS_KEYS) {
    it(`en.run.${key} is a non-empty string`, () => {
      expect(typeof ns[key]).toBe("string");
      expect((ns[key] as string).length).toBeGreaterThan(0);
    });
  }
});

describe("i18n — M11c settings-panel keys exist in RU", () => {
  const ns = runNs(ru as unknown as Catalog);

  for (const key of RUN_SETTINGS_KEYS) {
    it(`ru.run.${key} is a non-empty string`, () => {
      expect(typeof ns[key]).toBe("string");
      expect((ns[key] as string).length).toBeGreaterThan(0);
    });
  }
});

describe("i18n — EN and RU `run` namespaces stay in key parity", () => {
  it("every EN run key exists in RU and vice versa (no missing translation)", () => {
    const enKeys = Object.keys(runNs(en as unknown as Catalog)).sort();
    const ruKeys = Object.keys(runNs(ru as unknown as Catalog)).sort();

    expect(ruKeys).toEqual(enKeys);
  });

  it("all required M11c settings keys are present in BOTH catalogs", () => {
    const enKeys = new Set(Object.keys(runNs(en as unknown as Catalog)));
    const ruKeys = new Set(Object.keys(runNs(ru as unknown as Catalog)));
    const missingEn = RUN_SETTINGS_KEYS.filter((k) => !enKeys.has(k));
    const missingRu = RUN_SETTINGS_KEYS.filter((k) => !ruKeys.has(k));

    expect(missingEn).toEqual([]);
    expect(missingRu).toEqual([]);
  });
});
