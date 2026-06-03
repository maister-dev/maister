import { describe, expect, it } from "vitest";

import en from "@/messages/en.json";
import ru from "@/messages/ru.json";

// ---------------------------------------------------------------------------
// CONTRACT under test — M16 Phase 7 i18n key for the board external_check
// gate-readiness badge.
//
// Namespace decision: the badge string lives under the EXISTING `board`
// namespace, alongside the sibling evidence-badge strings
// (board.evidenceStale, board.mergeBlocked) it mirrors.
//
// Required key (EN + RU, identical):
//   board.externalGatePending   (badge aria-label / title text)
//
// The key does not exist yet → this test is RED until both catalogs gain it.
// ---------------------------------------------------------------------------

const BOARD_KEY = "externalGatePending";

type Catalog = Record<string, Record<string, unknown>>;

function boardNs(cat: Catalog): Record<string, unknown> {
  return (cat.board ?? {}) as Record<string, unknown>;
}

describe("i18n — M16 Phase 7 board.externalGatePending key", () => {
  it(`en.board.${BOARD_KEY} is a non-empty string`, () => {
    const ns = boardNs(en as unknown as Catalog);

    expect(typeof ns[BOARD_KEY]).toBe("string");
    expect((ns[BOARD_KEY] as string).length).toBeGreaterThan(0);
  });

  it(`ru.board.${BOARD_KEY} is a non-empty string`, () => {
    const ns = boardNs(ru as unknown as Catalog);

    expect(typeof ns[BOARD_KEY]).toBe("string");
    expect((ns[BOARD_KEY] as string).length).toBeGreaterThan(0);
  });

  it("the key is present in BOTH catalogs (no missing translation)", () => {
    const enKeys = new Set(Object.keys(boardNs(en as unknown as Catalog)));
    const ruKeys = new Set(Object.keys(boardNs(ru as unknown as Catalog)));

    expect(enKeys.has(BOARD_KEY)).toBe(true);
    expect(ruKeys.has(BOARD_KEY)).toBe(true);
  });
});
