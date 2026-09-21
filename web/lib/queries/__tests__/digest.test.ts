// UT-ATN-12 (ADR-169, ADR-172) — the digest is deterministic.
//
// The property under test is BYTE-identity: the same window and the same labels
// must produce the same string every time, in any order, on any run. That is
// what later makes the digest a safe push payload (T7.7) rather than a sentence
// that reads differently each time it is generated. There is no agent here, no
// narration, and no currency — a digest that says "$4.12 spent" would be a cost
// claim the read model cannot substantiate.

import { describe, expect, it } from "vitest";

import en from "@/messages/en.json";
import ru from "@/messages/ru.json";
import {
  DIGEST_CRASHED_EVENT_KIND,
  formatDigest,
  NOW_TILE_HREFS,
  NOW_TILE_IDS,
  type DigestLabels,
  type DigestWindow,
  type NowTileId,
} from "@/lib/queries/digest";
import { ATTENTION_EVENT_KINDS } from "@/lib/domain-events/taxonomy";

const SINCE = new Date("2026-09-10T00:00:00.000Z");

function windowOf(values: Partial<Record<NowTileId, number>>): DigestWindow {
  return {
    since: SINCE,
    hasCursor: true,
    tiles: NOW_TILE_IDS.map((id) => ({
      id,
      value: values[id] ?? 0,
      href: NOW_TILE_HREFS[id],
    })),
  };
}

const enLabels = en.digest as DigestLabels;
const ruLabels = ru.digest as DigestLabels;

describe("UT-ATN-12 the digest is byte-identical for the same rows", () => {
  it("returns the same string on repeated calls", () => {
    const window = windowOf({
      promoted: 2,
      crashed: 1,
      decisions: 3,
      events: 11,
      tokens: 48210,
    });
    const first = formatDigest(window, { locale: "en", labels: enLabels });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(formatDigest(window, { locale: "en", labels: enLabels })).toBe(
        first,
      );
    }
    expect(first).toBe(
      "2 promoted · 1 crashed · 3 new decisions · 11 new events · 48,210 tokens",
    );
  });

  // Determinism has to hold for the same ROW SET, not for the same array — a
  // caller that reshuffled its tiles must not get a different sentence.
  it("ignores the order the caller happened to build its tiles in", () => {
    const window = windowOf({ promoted: 1, crashed: 2, tokens: 3 });
    const shuffled: DigestWindow = {
      ...window,
      tiles: [...window.tiles].reverse(),
    };

    expect(formatDigest(shuffled, { locale: "en", labels: enLabels })).toBe(
      formatDigest(window, { locale: "en", labels: enLabels }),
    );
  });

  it("drops zero-valued tiles instead of listing what did not happen", () => {
    expect(
      formatDigest(windowOf({ crashed: 1 }), {
        locale: "en",
        labels: enLabels,
      }),
    ).toBe("1 crashed");
  });

  it("collapses an all-zero window to one clause, never to an empty string", () => {
    const empty = formatDigest(windowOf({}), {
      locale: "en",
      labels: enLabels,
    });

    expect(empty).toBe(enLabels.empty);
    expect(empty.length).toBeGreaterThan(0);
  });

  it("carries no currency and consumes every $count placeholder", () => {
    const rendered = formatDigest(
      windowOf({ promoted: 1, crashed: 1, decisions: 1, events: 1, tokens: 1 }),
      { locale: "en", labels: enLabels },
    );

    expect(rendered).not.toContain("$");
    expect(rendered.toLowerCase()).not.toContain("usd");
  });
});

describe("UT-ATN-12 numbers follow the reader's locale", () => {
  it("groups a token total the RU way under the ru locale", () => {
    const window = windowOf({ tokens: 1234567 });
    const rendered = formatDigest(window, { locale: "ru", labels: ruLabels });

    expect(rendered).toBe(
      ruLabels.tokens.replace(
        "$count",
        new Intl.NumberFormat("ru").format(1234567),
      ),
    );
    // RU groups with a non-breaking space, EN with commas — asserting the raw
    // digits would pass under either and prove nothing.
    expect(rendered).toContain("1 234 567");
    expect(rendered).not.toContain("1,234,567");
  });

  it("groups the same total the EN way under the en locale", () => {
    expect(
      formatDigest(windowOf({ tokens: 1234567 }), {
        locale: "en",
        labels: enLabels,
      }),
    ).toContain("1,234,567");
  });

  it("stays deterministic per locale", () => {
    const window = windowOf({ events: 4, tokens: 9000 });

    expect(formatDigest(window, { locale: "ru", labels: ruLabels })).toBe(
      formatDigest(window, { locale: "ru", labels: ruLabels }),
    );
  });
});

describe("UT-ATN-12 the tile vocabulary", () => {
  it("labels every tile in both locales, with a $count placeholder", () => {
    for (const id of NOW_TILE_IDS) {
      for (const labels of [enLabels, ruLabels]) {
        expect(labels[id]).toBeTruthy();
        expect(labels[id]).toContain("$count");
        expect(labels[id]).not.toContain("{count");
      }
    }
    expect(enLabels.empty).not.toContain("$count");
    expect(ruLabels.empty).not.toContain("$count");
  });

  it("gives every tile a destination", () => {
    for (const id of NOW_TILE_IDS) {
      expect(NOW_TILE_HREFS[id].startsWith("/")).toBe(true);
    }
    expect(new Set(Object.values(NOW_TILE_HREFS)).size).toBe(
      NOW_TILE_IDS.length,
    );
  });

  // A taxonomy rename would otherwise leave the crashed tile permanently zero
  // with nothing failing.
  it("counts a kind the attention plane still carries", () => {
    expect([...ATTENTION_EVENT_KINDS]).toContain(DIGEST_CRASHED_EVENT_KIND);
  });

  // Rehomed from `desk-contract.test.ts` by ADR-174. The Desk no longer renders
  // this vocabulary — the notification trigger is its only caller now — but the
  // vocabulary itself still has to hold, and it belongs beside the module that
  // owns it rather than beside a page that stopped using it.
  it("names every tile in both catalogs, with an aria label", () => {
    for (const catalog of [en.digest, ru.digest] as Array<
      Record<string, string>
    >) {
      for (const id of NOW_TILE_IDS) {
        expect(catalog[id], id).toContain("$count");
      }
      expect(catalog.ariaLabel).toBeTruthy();
    }
  });

  it("points every tile at a route that exists", () => {
    for (const id of NOW_TILE_IDS) {
      const href = NOW_TILE_HREFS[id];
      const route = href.split("?")[0];

      expect(
        ["/work", "/inbox", "/activity", "/observatory"],
        `${id} -> ${href}`,
      ).toContain(route);
    }
  });

  it("opens the Observatory cost view from the tokens tile (ADR-177)", () => {
    expect(NOW_TILE_HREFS.tokens).toBe("/observatory?view=cost");
  });
});
