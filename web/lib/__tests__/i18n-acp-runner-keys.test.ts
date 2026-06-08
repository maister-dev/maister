import { describe, expect, it } from "vitest";

import en from "@/messages/en.json";
import ru from "@/messages/ru.json";

// ---------------------------------------------------------------------------
// CONTRACT under test — i18n keys for the admin ACP-runner catalog UI:
//   components/settings/acp-runners-panel.tsx (view-only table)
//   components/settings/acp-runner-modal.tsx  (create | edit | delete modal)
//
// All keys live under the EXISTING `settings` namespace (the admin platform
// settings page already owns it). Each key must be a non-empty string in BOTH
// EN and RU, and the EN/RU presence of these keys must stay at parity.
//
// RED now — none of these keys exist yet.
// ---------------------------------------------------------------------------

const ACP_RUNNER_KEYS = [
  "addRunner",
  "createRunnerTitle",
  "editRunnerTitle",
  "editAction",
  "deleteRunner",
  "fromPreset",
  "sidecarNone",
  "colId",
  "colAdapter",
  "colModel",
  "colProvider",
  "colSidecar",
  "colPolicy",
  "colReadiness",
  "colEnabled",
  "colActions",
  "fieldId",
  "fieldModel",
  "fieldProviderKind",
  "fieldBaseUrl",
  "fieldAuthToken",
  "fieldApiKey",
  "fieldWireApi",
  "fieldPermissionPolicy",
  "fieldSidecar",
  "fieldEnabled",
  "deleteConfirm",
  "deleteBlockedTitle",
  "deleteBlockedIntro",
  "validId",
  "validEnvRef",
  "validUrl",
  "policyDefault",
  "policyDangerous",
  "saveFailed",
] as const;

type Catalog = Record<string, Record<string, unknown>>;

function settingsNs(cat: Catalog): Record<string, unknown> {
  return (cat.settings ?? {}) as Record<string, unknown>;
}

describe("i18n — ACP runner settings keys exist in EN", () => {
  const ns = settingsNs(en as unknown as Catalog);

  for (const key of ACP_RUNNER_KEYS) {
    it(`en.settings.${key} is a non-empty string`, () => {
      expect(typeof ns[key]).toBe("string");
      expect((ns[key] as string).length).toBeGreaterThan(0);
    });
  }
});

describe("i18n — ACP runner settings keys exist in RU", () => {
  const ns = settingsNs(ru as unknown as Catalog);

  for (const key of ACP_RUNNER_KEYS) {
    it(`ru.settings.${key} is a non-empty string`, () => {
      expect(typeof ns[key]).toBe("string");
      expect((ns[key] as string).length).toBeGreaterThan(0);
    });
  }
});

describe("i18n — EN and RU `settings` ACP runner keys stay in parity", () => {
  it("each ACP runner key is present in BOTH catalogs (no missing translation)", () => {
    const enKeys = new Set(Object.keys(settingsNs(en as unknown as Catalog)));
    const ruKeys = new Set(Object.keys(settingsNs(ru as unknown as Catalog)));
    const missingEn = ACP_RUNNER_KEYS.filter((k) => !enKeys.has(k));
    const missingRu = ACP_RUNNER_KEYS.filter((k) => !ruKeys.has(k));

    expect(missingEn).toEqual([]);
    expect(missingRu).toEqual([]);
  });

  it("the ACP runner key sets are identical across EN and RU", () => {
    const enPresent = ACP_RUNNER_KEYS.filter(
      (k) => k in settingsNs(en as unknown as Catalog),
    );
    const ruPresent = ACP_RUNNER_KEYS.filter(
      (k) => k in settingsNs(ru as unknown as Catalog),
    );

    expect(ruPresent).toEqual(enPresent);
  });
});
