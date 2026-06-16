// Phase 1 (T1.4 / T1.8, RED): failing render tests for the NEW server
// component `CodeView`, migrated from the retired `file-viewer.test.ts`.
//
// `web/components/workbench/code-view.tsx` does not exist yet — these tests RED
// on the missing import (`@/components/workbench/code-view`).
//
// Style: node env, no jsdom; renderToStaticMarkup, mirroring
// components/workbench/__tests__/run-diff.test.ts and the retired
// file-viewer.test.ts. `.test.ts` matches the `unit` project glob
// (`components/**/__tests__/**/*.test.ts`).
//
// CodeView is an ASYNC server component (it awaits highlightToHtml), so we
// render it as: `const el = await CodeView(props); renderToStaticMarkup(el)`.
// NO "use client", NO fetching, NO effects — it is handed an already-read,
// already-validated blob result.
//
// Frozen interface (architect-fixed — ADR-066, plan T1.4):
//   export function CodeView(props: {
//     blob: RepoBlobResult;            // from @/lib/worktree
//     labels: CodeViewLabels;          // mirrors file-viewer's FileViewerLabels
//     path?: string;
//   }): Promise<ReactElement>
//
// RepoBlobResult (confirmed lib/worktree.ts:1116) =
//   | { kind: "text"; content: string }
//   | { kind: "too-large"; size: number }
//   | { kind: "binary" }
//   | { kind: "not-found" }
// NOTE: readBlob has NO distinct "empty" kind — an empty file surfaces as
//       { kind: "text", content: "" }, which CodeView renders as the empty
//       state (plan T1.4/T1.8: "empty text (content:\"\") → the existing
//       empty state").
//
// Rendering contract per kind (migrated from file-viewer.test.ts):
//   text (non-empty) -> highlighted container data-testid="code-view";
//                       contains the source text AND line-number structure;
//                       the OLD <pre data-testid="file-content"> is GONE.
//   text (content="")-> empty state data-testid="file-empty"; NOT code-view.
//   too-large        -> labels.tooLarge + data-testid="file-too-large"; the
//                       byte size; NOT code-view.
//   binary           -> labels.binary + data-testid="file-binary"; NOT code-view.
//   not-found        -> a not-found/error state; NOT code-view (resilient: we
//                       do not pin the exact testid/label the Implementor picks).

import type { RepoBlobResult } from "@/lib/worktree";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CodeView } from "@/components/workbench/code-view";

// Mirrors file-viewer's FileViewerLabels (tooLarge/binary/loadError/loading/
// empty). `loading` is carried for prop-shape parity even though the server
// component never renders a loading state (no client fetch). The Implementor
// may narrow this; the tests only assert on the labels they exercise.
type CodeViewLabels = {
  tooLarge: string;
  binary: string;
  loadError: string;
  loading: string;
  empty: string;
};

const labels: CodeViewLabels = {
  tooLarge: "File is too large to display",
  binary: "Binary file — not shown",
  loadError: "Could not load file",
  loading: "Loading…",
  empty: "Select a file to view",
};

async function render(blob: RepoBlobResult, path?: string): Promise<string> {
  const el = await CodeView({ blob, labels, path });

  return renderToStaticMarkup(el);
}

describe("CodeView — text state (highlighted)", () => {
  const content = "export const answer = 42;\n";

  it("renders the highlighted container with data-testid='code-view'", async () => {
    const html = await render({ kind: "text", content }, "src/answer.ts");

    expect(html).toContain('data-testid="code-view"');
  });

  it("renders the source text inside the highlighted view", async () => {
    const html = await render({ kind: "text", content }, "src/answer.ts");

    // IMPLEMENTOR FIX (objectively-wrong expectation): Shiki wraps each token in
    // its own <span>, so a whole source line is not a contiguous substring of
    // the markup. The faithful intent — "the source text is rendered" — is
    // asserted against the tag-stripped text.
    const text = html.replace(/<[^>]+>/g, "");

    expect(text).toContain("export const answer = 42;");
  });

  it("does NOT render the retired <pre data-testid='file-content'>", async () => {
    const html = await render({ kind: "text", content }, "src/answer.ts");

    expect(html).not.toContain('data-testid="file-content"');
  });

  it("renders per-line structure (line numbers) for multi-line content", async () => {
    const multi = ["const a = 1;", "const b = 2;", "const c = 3;"].join("\n");
    const html = await render({ kind: "text", content: multi }, "src/multi.ts");

    const lineCount = (html.match(/class="[^"]*line[^"]*"/g) ?? []).length;

    expect(lineCount).toBeGreaterThanOrEqual(3);

    // IMPLEMENTOR FIX (objectively-wrong expectation): see note above — assert
    // the rendered (tag-stripped) text carries each line, since tokenized
    // highlighting splits a line across spans.
    const text = html.replace(/<[^>]+>/g, "");

    expect(text).toContain("const a = 1;");
    expect(text).toContain("const c = 3;");
  });
});

describe("CodeView — rich target renderers", () => {
  it("renders markdown as a target rich view with mermaid blocks", async () => {
    const content = [
      "# Active workspaces",
      "",
      "```mermaid",
      "graph TD",
      "  A-->B",
      "```",
    ].join("\n");
    const html = await render({ kind: "text", content }, "docs/screen.md");

    expect(html).toContain('data-testid="markdown-rich-view"');
    expect(html).toContain("<h1>Active workspaces</h1>");
    expect(html).toContain('data-testid="mermaid-diagram"');
    expect(html).not.toContain('data-testid="code-view"');
  });
});

describe("CodeView — empty text (content: '')", () => {
  const html = (): Promise<string> =>
    render({ kind: "text", content: "" }, "empty.ts");

  it("renders the empty marker with data-testid='file-empty'", async () => {
    const out = await html();

    expect(out).toContain('data-testid="file-empty"');
    expect(out).toContain(labels.empty);
  });

  it("does NOT render the highlighted code-view container", async () => {
    const out = await html();

    expect(out).not.toContain('data-testid="code-view"');
  });
});

describe("CodeView — too-large state", () => {
  const html = (): Promise<string> =>
    render({ kind: "too-large", size: 1048576 }, "big.bin");

  it("renders the tooLarge label with data-testid='file-too-large'", async () => {
    const out = await html();

    expect(out).toContain('data-testid="file-too-large"');
    expect(out).toContain(labels.tooLarge);
  });

  it("shows the byte size", async () => {
    expect(await html()).toContain("1048576");
  });

  it("does NOT render the highlighted code-view container", async () => {
    expect(await html()).not.toContain('data-testid="code-view"');
  });
});

describe("CodeView — binary state", () => {
  const html = (): Promise<string> => render({ kind: "binary" }, "logo.png");

  it("renders the binary label with data-testid='file-binary'", async () => {
    const out = await html();

    expect(out).toContain('data-testid="file-binary"');
    expect(out).toContain(labels.binary);
  });

  it("does NOT render the highlighted code-view container", async () => {
    expect(await html()).not.toContain('data-testid="code-view"');
  });
});

describe("CodeView — not-found state", () => {
  // readBlob hides non-blob/ignored/missing paths uniformly as not-found.
  // We keep this assertion resilient: the exact testid/label is the
  // Implementor's choice, but it MUST NOT render the highlighted view and MUST
  // render *some* non-empty fallback (no crash, no blank output).
  const html = (): Promise<string> => render({ kind: "not-found" }, "ghost.ts");

  it("does NOT render the highlighted code-view container", async () => {
    expect(await html()).not.toContain('data-testid="code-view"');
  });

  it("renders a non-empty fallback rather than the source", async () => {
    const out = await html();

    expect(out.length).toBeGreaterThan(0);
    expect(out).not.toContain('data-testid="file-content"');
  });
});
