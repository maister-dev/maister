// UT-ATN-05 (ADR-168 D9) — `needsYou` is RETIRED, not deprecated.
//
// A deprecated alias would leave a second way to compute a canonical number,
// which is exactly the drift this decision exists to remove. So the assertion
// is not "the new counter works" — it is "the old one is gone", enforced by
// reading the tree rather than by anyone remembering.
//
// Two paths are exempt on purpose (D10): the external pulse's `needsYouCount`
// is a frozen contract that every deployed assistant reads, and it keeps its
// exact HITL-only semantics forever.

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const WEB_ROOT = path.resolve(__dirname, "../../..");

// The ext boundary D10 freezes, plus this file, which must name the identifier
// in order to forbid it.
const EXEMPT = [
  "lib/ext-activity",
  "app/api/v1/ext/activity",
  "lib/queries/__tests__/needs-you-retired.test.ts",
];

const SKIP_DIRS = new Set([
  "node_modules",
  ".next",
  ".turbo",
  "dist",
  "coverage",
  "test-results",
  "playwright-report",
]);

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry) || entry.startsWith(".")) continue;

    const full = path.join(dir, entry);

    if (statSync(full).isDirectory()) {
      yield* sourceFiles(full);
      continue;
    }

    if (/\.(ts|tsx)$/u.test(entry)) yield full;
  }
}

function survivingReferences(): string[] {
  const hits: string[] = [];

  for (const file of sourceFiles(WEB_ROOT)) {
    const rel = path.relative(WEB_ROOT, file);

    if (EXEMPT.some((prefix) => rel.startsWith(prefix))) continue;
    if (/needsyou/iu.test(readFileSync(file, "utf8"))) hits.push(rel);
  }

  return hits.sort();
}

describe("UT-ATN-05 the needsYou identifier is gone", () => {
  it("survives nowhere outside the two frozen ext paths", () => {
    expect(survivingReferences()).toEqual([]);
  });

  it("can still see the identifier where it is deliberately kept", () => {
    // A grep gate that matches nothing anywhere is indistinguishable from a
    // broken gate. The exempt path must still contain what the gate forbids.
    const pulse = readFileSync(
      path.join(WEB_ROOT, "lib/ext-activity/types.ts"),
      "utf8",
    );

    expect(/needsYou/u.test(pulse)).toBe(true);
  });

  it("has no needs-you query module left to import", () => {
    expect(() =>
      statSync(path.join(WEB_ROOT, "lib/queries/needs-you.ts")),
    ).toThrow();
  });
});

describe("CT-ATN-06 the external pulse's needsYou semantics do not change", () => {
  const ROUTE = "app/api/v1/ext/activity/route.ts";

  it("still computes needsYouCount from the HITL items alone", () => {
    const source = readFileSync(path.join(WEB_ROOT, ROUTE), "utf8");

    // HITL items only. Folding promotable runs — or the new `decisions` queue —
    // into this series would silently redefine a number every deployed
    // assistant already reads (ADR-152 D4, restated by ADR-168 D10).
    expect(source).toContain("needsYouCount: response.needsYou.items.length");
    expect(source).toContain(
      "promotableCount: response.needsYou.promotable.length",
    );
  });

  it("does not reach for the retired counter or the new queue", () => {
    const source = readFileSync(path.join(WEB_ROOT, ROUTE), "utf8");

    expect(source).not.toContain("@/lib/queries/decisions");
    expect(source).not.toContain("getDecisionsCount");
  });

  it("keeps the pulse payload's needsYou block at its three documented keys", () => {
    const types = readFileSync(
      path.join(WEB_ROOT, "lib/ext-activity/types.ts"),
      "utf8",
    );
    const block = types.slice(types.indexOf("  needsYou: {"));

    expect(block.slice(0, block.indexOf("};"))).toContain("generatedAt");
    expect(block.slice(0, block.indexOf("};"))).toContain("items");
    expect(block.slice(0, block.indexOf("};"))).toContain("promotable");
  });
});

describe("UT-ATN-05 every migrated surface reads the one canonical counter", () => {
  const SURFACES = [
    "app/(app)/layout.tsx",
    // `/` is the Desk and `/projects` the relocated portfolio (ADR-171 D1/D2).
    // Both render a decisions number, so both stay on this list — dropping the
    // moved page would retire the check along with the route.
    "app/(app)/page.tsx",
    "app/(app)/projects/page.tsx",
    "app/(app)/inbox/page.tsx",
    "app/(app)/projects/[slug]/page.tsx",
  ];

  it("imports the count from the decisions read model, on every one", () => {
    for (const surface of SURFACES) {
      const source = readFileSync(path.join(WEB_ROOT, surface), "utf8");

      expect(source).toContain('from "@/lib/queries/decisions"');
    }
  });

  it("recomputes the number nowhere — no surface sums its own populations", () => {
    for (const surface of SURFACES) {
      const source = readFileSync(path.join(WEB_ROOT, surface), "utf8");

      expect(source).not.toMatch(/\.count \+ unread/u);
    }
  });
});
