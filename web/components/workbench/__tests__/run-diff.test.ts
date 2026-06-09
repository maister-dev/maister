// M22 Phase 5 (T5.4) → ADR-066 Phase 2 (T2.8) migration: render tests for the
// PRESENTATIONAL changed-files list of the workbench diff surface.
//
// We render ONLY the named, presentational export `ChangedFilesList` — it takes
// a seeded `DiffFileEntry[]` and has NO fetching and NO effects. The fetching
// container `RunDiff({ runId, labels })` lazily fetches `GET /api/runs/${runId}/diff`
// and (post-ADR-066) renders <DiffView/> (git-diff-view) + the changed-files
// list; under renderToStaticMarkup effects DO NOT run, so the container is NOT
// the render-test target here (its fetch + diff-view are the e2e's job).
//
// ADR-066 migration notes:
//   - The raw-diff `<pre>` is GONE; per-file split now lives in
//     `lib/diff/prepare.ts` (`prepareDiff`), so the old `extractFileSection`
//     describe block RELOCATES to `lib/diff/__tests__/prepare.test.ts`
//     ("splits the two files apart") and is removed here.
//   - The changed-files list gains per-file `+`/`−` count badges; we add a
//     resilient assertion that the counts render alongside the existing
//     data-status / path assertions.
//
// Mirrors components/workbench/__tests__/file-tree.test.ts (createElement +
// renderToStaticMarkup, no jsdom). `.test.ts` to match the unit glob
// (`components/**/__tests__/**/*.test.ts`).

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ChangedFilesList } from "@/components/workbench/run-diff";

// The changed-files entry gains `additions`/`deletions` for the per-file `+`/`−`
// badges (server-computed in prepareDiff; ADR-066 T2.3/T2.5).
type DiffFileEntry = {
  path: string;
  status: string;
  additions?: number;
  deletions?: number;
};

const LABELS = { empty: "workbench.diff.empty" };

// Distinctive double-digit counts chosen to avoid colliding with the digits in
// the component's Tailwind class strings (e.g. `text-[11px]`, `w-3`), so the
// badge assertion can only pass when the counts are actually rendered.
const SEED: DiffFileEntry[] = [
  { path: "src/a.ts", status: "M", additions: 42, deletions: 17 },
  { path: "b.ts", status: "A", additions: 88, deletions: 0 },
];

function render(files: DiffFileEntry[]): string {
  return renderToStaticMarkup(
    createElement(ChangedFilesList, { files, labels: LABELS }),
  );
}

describe("ChangedFilesList — seeded changed-files rendering (M22 T5.4 → ADR-066)", () => {
  const html = render(SEED);

  it("renders one item per changed file", () => {
    const count = html.split('data-testid="changed-file"').length - 1;

    expect(count).toBe(SEED.length);
  });

  it("renders each file's path text", () => {
    for (const file of SEED) {
      expect(html).toContain(file.path);
    }
  });

  it("renders the modify entry with data-status='M'", () => {
    expect(html).toContain('data-status="M"');
  });

  it("renders the add entry with data-status='A'", () => {
    expect(html).toContain('data-status="A"');
  });

  it("renders the per-file +/− count badges (ADR-066)", () => {
    // The list shows server-computed additions/deletions per file. Assert the
    // distinctive counts appear (resilient to the badge's exact markup / `+`/`−`
    // glyph choice — we check the numeric counts render, not a fixed testid).
    expect(html).toContain("42"); // src/a.ts additions
    expect(html).toContain("17"); // src/a.ts deletions
    expect(html).toContain("88"); // b.ts additions
  });

  it("renders the empty-state label for an empty files list", () => {
    const empty = render([]);

    expect(empty).toContain("workbench.diff.empty");
    expect(empty).not.toContain('data-testid="changed-file"');
  });
});
