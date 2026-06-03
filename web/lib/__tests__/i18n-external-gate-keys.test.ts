import { describe, expect, it } from "vitest";

import en from "@/messages/en.json";
import ru from "@/messages/ru.json";

// ---------------------------------------------------------------------------
// TOMBSTONE — M17 removal of board.externalGatePending.
//
// The key was added in M16 Phase 7 for an external-check readiness badge.
// Task 15 unified all readiness badge labels under the `readiness` namespace
// (readiness.ready / .blocked / .stale / .failed / .waiting / .overridden).
// Task 16 removed the portfolio consumer; Task 15 removed the board consumer.
// No live t("externalGatePending") or tBoard("externalGatePending") call
// remains — confirmed by grep in M17.
//
// This test guards the removal: the key must NOT exist in either catalog.
// If it reappears, the unified readiness namespace becomes the source of
// truth and this duplicate should be deleted again.
// ---------------------------------------------------------------------------

const REMOVED_KEY = "externalGatePending";

type Catalog = Record<string, Record<string, unknown>>;

function boardNs(cat: Catalog): Record<string, unknown> {
  return (cat.board ?? {}) as Record<string, unknown>;
}

describe("i18n — board.externalGatePending is removed (superseded by readiness namespace)", () => {
  it("en.board does NOT contain the removed externalGatePending key", () => {
    const ns = boardNs(en as unknown as Catalog);

    expect(Object.prototype.hasOwnProperty.call(ns, REMOVED_KEY)).toBe(false);
  });

  it("ru.board does NOT contain the removed externalGatePending key", () => {
    const ns = boardNs(ru as unknown as Catalog);

    expect(Object.prototype.hasOwnProperty.call(ns, REMOVED_KEY)).toBe(false);
  });
});
