// ---------------------------------------------------------------------------
// UT-NTF-13 — `createHitlRequest` is the ONLY writer of `hitl_requests`.
//
// A HITL row IS a decision opening, and `domain_events` now carries a kind for
// it. Emitting from the fifteen independent inserts this replaced would make a
// MISSED site a silent gap — no error, no notification, and no way to notice
// short of a reader complaining. The guard is a grep because the property is
// "nowhere else", which no type can express.
//
// If this fails: route the new insert through `createHitlRequest` (or
// `createHitlRequestIfAbsent`), and pass `{ silent: true }` only if the row
// genuinely does not open a decision the reader must be told about.
// ---------------------------------------------------------------------------
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const WEB_ROOT = path.resolve(__dirname, "../../..");

const EXEMPT = [
  // The writer itself.
  "lib/runs/hitl-create.ts",
  // This guard, which must name the pattern in order to forbid it.
  "lib/runs/__tests__/hitl-single-writer.test.ts",
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

function directWriters(): string[] {
  const hits: string[] = [];

  for (const file of sourceFiles(WEB_ROOT)) {
    const rel = path.relative(WEB_ROOT, file);

    if (EXEMPT.includes(rel)) continue;
    // Test fixtures seed rows directly and are not production writers.
    if (rel.includes("__tests__") || rel.startsWith("e2e/")) continue;
    if (
      /insert\(\s*(?:schema\.)?hitlRequests\s*\)/u.test(
        readFileSync(file, "utf8"),
      )
    ) {
      hits.push(rel);
    }
  }

  return hits.sort();
}

describe("UT-NTF-13 one writer of hitl_requests", () => {
  it("has no production insert outside createHitlRequest", () => {
    expect(directWriters()).toEqual([]);
  });

  it("can still see the pattern where it is deliberately kept", () => {
    // A grep gate that matches nothing anywhere is indistinguishable from a
    // broken gate: the writer itself must still contain what the gate forbids.
    const writer = readFileSync(
      path.join(WEB_ROOT, "lib/runs/hitl-create.ts"),
      "utf8",
    );

    expect(/insert\(hitlRequests\)/u.test(writer)).toBe(true);
  });

  it("emits the decision-opening kind from that one writer", () => {
    const writer = readFileSync(
      path.join(WEB_ROOT, "lib/runs/hitl-create.ts"),
      "utf8",
    );

    expect(writer).toContain('kind: "run.needs_input"');
  });
});
