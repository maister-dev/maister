// T4.5 (RED): failing render tests for the RepoFilesPanel server-side gate
// (Track B, Phase 4b). Uses renderToStaticMarkup (no jsdom), mirroring
// components/board/panels/__tests__/integrations-panel.test.ts.
//
// RepoFilesPanel is a Server Component that takes a `labels` PROP (built by the
// project page via getTranslations and passed down — the labels-as-props
// convention). Because it does NOT call async i18n internally, it is SYNC and
// renderToStaticMarkup-safe. (Contract ambiguity flagged to the implementor: do
// NOT make this component `async`/Promise-returning, or these render tests — and
// the integrations-panel precedent of NOT rendering the async i18n component —
// break. Keep RepoFilesPanel a sync gate that receives labels.)
//
// It renders the git-tracked file browser ONLY when `canReadRepoFiles` is true;
// the gate is enforced server-side, so a false value must render a forbidden
// notice and NO file-tree mount. The `FileTree` it mounts is a "use client"
// container whose lazy-fetch lives in an effect — effects DO NOT run under
// renderToStaticMarkup, so only its root mount markup (data-testid="file-tree")
// appears; that mount is the assertion target.
//
// Contract (module not built yet — RED on the missing import):
//   web/components/board/panels/repo-files-panel.tsx (Server Component) exports
//     RepoFilesPanel({ slug, canReadRepoFiles, labels }): ReactElement
//
//   labels carries at least: { forbidden, ...file-tree/viewer labels }
//
//   canReadRepoFiles === false -> data-testid="repo-files-forbidden" + labels.forbidden,
//                                 and NO data-testid="file-tree".
//   canReadRepoFiles === true  -> renders <FileTree filesApiBase="/api/projects/<slug>/files">
//                                 whose root carries data-testid="file-tree".

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { RepoFilesPanel } from "@/components/board/panels/repo-files-panel";

type RepoFilesLabels = {
  forbidden: string;
  title: string;
  empty: string;
  tooLarge: string;
  binary: string;
  loadError: string;
  loading: string;
};

const labels: RepoFilesLabels = {
  forbidden: "You do not have access to repository files",
  title: "Repo files",
  empty: "No files",
  tooLarge: "File is too large to display",
  binary: "Binary file — not shown",
  loadError: "Could not load file",
  loading: "Loading…",
};

function render(slug: string, canReadRepoFiles: boolean): string {
  return renderToStaticMarkup(
    createElement(RepoFilesPanel, { slug, canReadRepoFiles, labels }),
  );
}

describe("RepoFilesPanel — viewer gate (canReadRepoFiles=false)", () => {
  const html = render("acme", false);

  it("renders the forbidden marker with data-testid='repo-files-forbidden'", () => {
    expect(html).toContain('data-testid="repo-files-forbidden"');
    expect(html).toContain(labels.forbidden);
  });

  it("does NOT render the file-tree mount", () => {
    expect(html).not.toContain('data-testid="file-tree"');
  });
});

describe("RepoFilesPanel — member access (canReadRepoFiles=true)", () => {
  const html = render("acme", true);

  it("renders the file-tree mount with data-testid='file-tree'", () => {
    expect(html).toContain('data-testid="file-tree"');
  });

  it("does NOT render the forbidden marker", () => {
    expect(html).not.toContain('data-testid="repo-files-forbidden"');
  });
});
