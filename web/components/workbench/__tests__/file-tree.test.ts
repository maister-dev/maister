// T4.5 (RED): failing render tests for the PRESENTATIONAL file-tree row/list
// (Track B, Phase 4b). Uses renderToStaticMarkup (no jsdom), mirroring
// components/board/__tests__/flow-graph-view.test.ts and
// components/run/__tests__/readiness-summary.test.ts.
//
// We render ONLY the named, presentational export(s) — `FileTreeEntryRow` and
// `FileTreeList` — which take a seeded `{name, type}` entry and have NO fetching
// and NO effects. The fetching container `FileTree({ filesApiBase, labels })`
// lazily lists/expands dirs via `fetch(`${filesApiBase}?path=<dir>`)` inside an
// effect; under renderToStaticMarkup effects DO NOT run, so the container is NOT
// the render-test target here (its lazy-expand + keyboard behavior is the e2e's
// job, T6.2).
//
// Contract (module not built yet — RED on the missing import):
//   web/components/workbench/file-tree.tsx ("use client") exports
//     default FileTree({ filesApiBase, labels })            (container, NOT rendered here)
//     FileTreeEntryRow({ entry, depth, expanded }): ReactElement   (presentational)
//     FileTreeList({ entries }): ReactElement                      (presentational)
//
// Each rendered entry row MUST emit:
//   - data-testid="file-tree-entry"
//   - data-entry-type="file" | "dir"
//   - the entry name as text
//   - aria-expanded ONLY on a dir row (a file row has none).

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  FileTreeEntryRow,
  FileTreeList,
} from "@/components/workbench/file-tree";

type FileEntry = { name: string; type: "file" | "dir" };

const SEED: FileEntry[] = [
  { name: "src", type: "dir" },
  { name: "a.txt", type: "file" },
];

function renderRow(entry: FileEntry, depth: number, expanded: boolean): string {
  return renderToStaticMarkup(
    createElement(FileTreeEntryRow, { entry, depth, expanded }),
  );
}

function renderList(entries: FileEntry[]): string {
  return renderToStaticMarkup(createElement(FileTreeList, { entries }));
}

describe("FileTreeEntryRow — single entry rendering", () => {
  it("renders a dir entry with its name and data-entry-type='dir'", () => {
    const html = renderRow({ name: "src", type: "dir" }, 0, false);

    expect(html).toContain('data-testid="file-tree-entry"');
    expect(html).toContain('data-entry-type="dir"');
    expect(html).toContain("src");
  });

  it("renders a file entry with its name and data-entry-type='file'", () => {
    const html = renderRow({ name: "a.txt", type: "file" }, 0, false);

    expect(html).toContain('data-testid="file-tree-entry"');
    expect(html).toContain('data-entry-type="file"');
    expect(html).toContain("a.txt");
  });

  it("exposes aria-expanded on a dir row", () => {
    const html = renderRow({ name: "src", type: "dir" }, 0, false);

    expect(html).toContain("aria-expanded");
  });

  it("reflects the expanded state via aria-expanded='true' on an expanded dir row", () => {
    const html = renderRow({ name: "src", type: "dir" }, 0, true);

    expect(html).toContain('aria-expanded="true"');
  });

  it("does NOT expose aria-expanded on a file row", () => {
    const html = renderRow({ name: "a.txt", type: "file" }, 0, false);

    expect(html).not.toContain("aria-expanded");
  });
});

describe("FileTreeList — seeded entry list rendering", () => {
  const html = renderList(SEED);

  it("renders one entry per seeded entry", () => {
    const count = html.split('data-testid="file-tree-entry"').length - 1;

    expect(count).toBe(SEED.length);
  });

  it("renders each entry's name", () => {
    for (const entry of SEED) {
      expect(html).toContain(entry.name);
    }
  });

  it("renders the dir entry with data-entry-type='dir'", () => {
    expect(html).toContain('data-entry-type="dir"');
  });

  it("renders the file entry with data-entry-type='file'", () => {
    expect(html).toContain('data-entry-type="file"');
  });

  it("exposes aria-expanded for the dir entry only (one occurrence)", () => {
    const count = html.split("aria-expanded").length - 1;

    expect(count).toBe(1);
  });

  it("labels the root tree with the provided treeLabel (a11y name)", () => {
    const labelled = renderToStaticMarkup(
      createElement(FileTreeList, { entries: SEED, treeLabel: "Repo tree" }),
    );

    expect(labelled).toContain('role="tree"');
    expect(labelled).toContain('aria-label="Repo tree"');
  });
});
