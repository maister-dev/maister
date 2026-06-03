import { describe, expect, it } from "vitest";

import en from "@/messages/en.json";
import ru from "@/messages/ru.json";

// ---------------------------------------------------------------------------
// CONTRACT under test — M16 Phase 5 i18n keys for the project-board
// "Integrations" token-management UI panel.
//
// Namespace decision: all token-panel strings live under a NEW top-level
// `tokens` namespace (mirrors the existing `packages` namespace shape). The
// board tab label lives under the EXISTING `nav` namespace as `nav.integrations`
// (mirrors `nav.packages`, `nav.mcps`, etc).
//
// Required keys under `tokens` (EN + RU, identical key set):
//   Panel framing:
//     tokens.title              (panel heading)
//     tokens.empty              (empty-state — no tokens yet)
//     tokens.adminOnly          (notice shown to non-admins)
//   Create-token modal:
//     tokens.create             (open-create-modal button label)
//     tokens.createTitle        (modal heading)
//     tokens.nameLabel          (token-name field label)
//     tokens.namePlaceholder    (token-name field placeholder)
//     tokens.expiresLabel       (expiry field label)
//     tokens.cancel             (modal cancel button)
//     tokens.confirm            (modal confirm button)
//   One-time secret reveal:
//     tokens.secretTitle        (reveal heading)
//     tokens.secretWarning      (shown-once warning copy)
//     tokens.copy               (copy-to-clipboard affordance)
//     tokens.copied             (post-copy confirmation)
//   Revoke:
//     tokens.revoke             (revoke affordance label)
//     tokens.revokeConfirm      (revoke confirmation prompt)
//   Table columns:
//     tokens.colName
//     tokens.colPrefix
//     tokens.colStatus
//     tokens.colCreated
//     tokens.colLastUsed
//     tokens.colExpires
//   Derived status labels:
//     tokens.statusActive
//     tokens.statusRevoked
//     tokens.statusExpired
//   Errors:
//     tokens.errorGeneric
//
// Until the implementor adds the `tokens` namespace (EN+RU) and `nav.integrations`
// (EN+RU), this test is RED: missing-key (undefined, not a string) failures.
// ---------------------------------------------------------------------------

const TOKENS_KEYS = [
  "title",
  "empty",
  "adminOnly",
  "create",
  "createTitle",
  "nameLabel",
  "namePlaceholder",
  "expiresLabel",
  "cancel",
  "confirm",
  "secretTitle",
  "secretWarning",
  "copy",
  "copied",
  "revoke",
  "revokeConfirm",
  "colName",
  "colPrefix",
  "colStatus",
  "colCreated",
  "colLastUsed",
  "colExpires",
  "statusActive",
  "statusRevoked",
  "statusExpired",
  "errorGeneric",
] as const;

type Catalog = Record<string, Record<string, unknown>>;

function tokensNs(cat: Catalog): Record<string, unknown> {
  return (cat.tokens ?? {}) as Record<string, unknown>;
}

function navNs(cat: Catalog): Record<string, unknown> {
  return (cat.nav ?? {}) as Record<string, unknown>;
}

describe("i18n — M16 tokens-panel keys exist in EN", () => {
  const ns = tokensNs(en as unknown as Catalog);

  for (const key of TOKENS_KEYS) {
    it(`en.tokens.${key} is a non-empty string`, () => {
      expect(typeof ns[key]).toBe("string");
      expect((ns[key] as string).length).toBeGreaterThan(0);
    });
  }
});

describe("i18n — M16 tokens-panel keys exist in RU", () => {
  const ns = tokensNs(ru as unknown as Catalog);

  for (const key of TOKENS_KEYS) {
    it(`ru.tokens.${key} is a non-empty string`, () => {
      expect(typeof ns[key]).toBe("string");
      expect((ns[key] as string).length).toBeGreaterThan(0);
    });
  }
});

describe("i18n — M16 nav.integrations tab label exists", () => {
  it("en.nav.integrations is a non-empty string", () => {
    const ns = navNs(en as unknown as Catalog);

    expect(typeof ns.integrations).toBe("string");
    expect((ns.integrations as string).length).toBeGreaterThan(0);
  });

  it("ru.nav.integrations is a non-empty string", () => {
    const ns = navNs(ru as unknown as Catalog);

    expect(typeof ns.integrations).toBe("string");
    expect((ns.integrations as string).length).toBeGreaterThan(0);
  });
});

describe("i18n — EN and RU `tokens` namespaces stay in key parity", () => {
  it("every EN tokens key exists in RU and vice versa (no missing translation)", () => {
    const enKeys = Object.keys(tokensNs(en as unknown as Catalog)).sort();
    const ruKeys = Object.keys(tokensNs(ru as unknown as Catalog)).sort();

    expect(ruKeys).toEqual(enKeys);
  });

  it("all required M16 tokens keys are present in BOTH catalogs", () => {
    const enKeys = new Set(Object.keys(tokensNs(en as unknown as Catalog)));
    const ruKeys = new Set(Object.keys(tokensNs(ru as unknown as Catalog)));
    const missingEn = TOKENS_KEYS.filter((k) => !enKeys.has(k));
    const missingRu = TOKENS_KEYS.filter((k) => !ruKeys.has(k));

    expect(missingEn).toEqual([]);
    expect(missingRu).toEqual([]);
  });
});
