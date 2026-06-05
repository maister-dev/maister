// M22 Phase 5 (T5.4, RED): failing render tests for the PRESENTATIONAL
// changed-files list of the workbench diff surface.
//
// We render ONLY the named, presentational export `ChangedFilesList` — it takes
// a seeded `DiffFileEntry[]` and has NO fetching and NO effects. The fetching
// container `RunDiff({ runId, labels })` lazily fetches `GET /api/runs/${runId}/diff`
// inside an effect and renders <RawDiff/> + the changed-files list; under
// renderToStaticMarkup effects DO NOT run, so the container is NOT the render-test
// target here (its fetch is the e2e's job, T6.2).
//
// Contract (module not built yet — RED on the missing import):
//   web/components/workbench/run-diff.tsx ("use client") exports
//     default RunDiff({ runId, labels })                          (container, NOT rendered here)
//     ChangedFilesList({ files, labels, onSelect? }): ReactElement (presentational)
//
// Each rendered item MUST emit:
//   - data-testid="changed-file"
//   - data-status={status}
//   - the path text
//   - empty files[] → labels.empty.
//
// Mirrors components/workbench/__tests__/file-tree.test.ts (createElement +
// renderToStaticMarkup, no jsdom). `.test.ts` to match the unit glob.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  ChangedFilesList,
  extractFileSection,
} from "@/components/workbench/run-diff";

type DiffFileEntry = { path: string; status: string };

const LABELS = { empty: "workbench.diff.empty" };

const SEED: DiffFileEntry[] = [
  { path: "src/a.ts", status: "M" },
  { path: "b.ts", status: "A" },
];

function render(files: DiffFileEntry[]): string {
  return renderToStaticMarkup(
    createElement(ChangedFilesList, { files, labels: LABELS }),
  );
}

describe("ChangedFilesList — seeded changed-files rendering (M22 T5.4)", () => {
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

  it("renders the empty-state label for an empty files list", () => {
    const empty = render([]);

    expect(empty).toContain("workbench.diff.empty");
    expect(empty).not.toContain('data-testid="changed-file"');
  });
});

describe("extractFileSection — filter the diff to one file's section", () => {
  const fullDiff = [
    "diff --git a/src/a.ts b/src/a.ts",
    "index 111..222 100644",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1 +1 @@",
    "+alpha",
    "diff --git a/b.ts b/b.ts",
    "index 333..444 100644",
    "--- a/b.ts",
    "+++ b/b.ts",
    "@@ -0,0 +1 @@",
    "+bravo",
  ].join("\n");

  it("returns only the selected file's section", () => {
    const section = extractFileSection(fullDiff, "b.ts");

    expect(section).toContain("diff --git a/b.ts b/b.ts");
    expect(section).toContain("+bravo");
    expect(section).not.toContain("src/a.ts");
    expect(section).not.toContain("+alpha");
  });

  it("returns the first file's section without bleeding into the next", () => {
    const section = extractFileSection(fullDiff, "src/a.ts");

    expect(section).toContain("+alpha");
    expect(section).not.toContain("+bravo");
  });

  it("falls back to the full diff when the path is not present", () => {
    expect(extractFileSection(fullDiff, "missing.ts")).toBe(fullDiff);
  });
});
