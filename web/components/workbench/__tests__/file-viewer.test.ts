// T4.5 (RED): failing render tests for the PRESENTATIONAL file-viewer body
// (Track B, Phase 4b). Uses renderToStaticMarkup (no jsdom), mirroring
// components/board/__tests__/flow-graph-view.test.ts.
//
// We render ONLY `FileViewerBody({ state, labels })` — the named, presentational
// export driven entirely by its `state` prop, with NO fetching and NO effects.
// The fetching container `FileViewer({ filesApiBase, path, labels })` GETs
// `${filesApiBase}/content?path=<path>` inside an effect; under
// renderToStaticMarkup effects DO NOT run, so the container is NOT the
// render-test target here.
//
// Contract (module not built yet — RED on the missing import):
//   web/components/workbench/file-viewer.tsx ("use client") exports
//     default FileViewer({ filesApiBase, path, labels })   (container, NOT rendered here)
//     FileViewerBody({ state, labels }): ReactElement       (presentational)
//
// state =
//     | { kind: "text"; content: string }
//     | { kind: "too-large"; size: number }
//     | { kind: "binary" }
//     | { kind: "loading" }
//     | { kind: "error" }
//     | { kind: "empty" }
//
// Rendering contract per kind:
//   text       -> <pre data-testid="file-content"> containing the content
//   too-large  -> labels.tooLarge + data-testid="file-too-large" + the size
//   binary     -> labels.binary   + data-testid="file-binary"
//   error      -> labels.loadError (+ data-testid="file-error")
//   loading    -> labels.loading  (+ data-testid="file-loading")
//   empty      -> labels.empty    (+ data-testid="file-empty")

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { FileViewerBody } from "@/components/workbench/file-viewer";

type FileViewerState =
  | { kind: "text"; content: string }
  | { kind: "too-large"; size: number }
  | { kind: "binary" }
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "empty" };

type FileViewerLabels = {
  tooLarge: string;
  binary: string;
  loadError: string;
  loading: string;
  empty: string;
};

const labels: FileViewerLabels = {
  tooLarge: "File is too large to display",
  binary: "Binary file — not shown",
  loadError: "Could not load file",
  loading: "Loading…",
  empty: "Select a file to view",
};

function render(state: FileViewerState): string {
  return renderToStaticMarkup(createElement(FileViewerBody, { state, labels }));
}

describe("FileViewerBody — text state", () => {
  it("renders the content inside a <pre> with data-testid='file-content'", () => {
    const content = "export const answer = 42;\n";
    const html = render({ kind: "text", content });

    expect(html).toContain('data-testid="file-content"');
    expect(html).toContain("<pre");
    expect(html).toContain("export const answer = 42;");
  });
});

describe("FileViewerBody — too-large state", () => {
  const html = render({ kind: "too-large", size: 1048576 });

  it("renders the tooLarge label with data-testid='file-too-large'", () => {
    expect(html).toContain('data-testid="file-too-large"');
    expect(html).toContain(labels.tooLarge);
  });

  it("shows the byte size", () => {
    expect(html).toContain("1048576");
  });

  it("does not render the file-content <pre>", () => {
    expect(html).not.toContain('data-testid="file-content"');
  });
});

describe("FileViewerBody — binary state", () => {
  const html = render({ kind: "binary" });

  it("renders the binary label with data-testid='file-binary'", () => {
    expect(html).toContain('data-testid="file-binary"');
    expect(html).toContain(labels.binary);
  });

  it("does not render the file-content <pre>", () => {
    expect(html).not.toContain('data-testid="file-content"');
  });
});

describe("FileViewerBody — error state", () => {
  const html = render({ kind: "error" });

  it("renders the loadError label", () => {
    expect(html).toContain(labels.loadError);
  });

  it("announces the error via role=alert + data-testid=file-error", () => {
    expect(html).toContain('data-testid="file-error"');
    expect(html).toContain('role="alert"');
  });
});

describe("FileViewerBody — loading state", () => {
  const html = render({ kind: "loading" });

  it("renders the loading marker", () => {
    expect(html).toContain(labels.loading);
  });

  it("does not render the file-content <pre>", () => {
    expect(html).not.toContain('data-testid="file-content"');
  });
});

describe("FileViewerBody — empty state", () => {
  const html = render({ kind: "empty" });

  it("renders the empty marker", () => {
    expect(html).toContain(labels.empty);
  });

  it("does not render the file-content <pre>", () => {
    expect(html).not.toContain('data-testid="file-content"');
  });
});
