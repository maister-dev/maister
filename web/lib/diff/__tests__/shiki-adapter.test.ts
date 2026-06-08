// Phase 2 (T2.2, RED): failing contract tests for the server-only Shiki@4
// `DiffHighlighter` adapter consumed by `@git-diff-view/react`. The module
// `web/lib/diff/shiki-adapter.ts` does not exist yet — these tests RED on the
// missing import (`@/lib/diff/shiki-adapter`).
//
// Style: node env, no jsdom; the async preload is awaited DIRECTLY (no React),
// mirroring `lib/highlight/__tests__/shiki.test.ts`. `.test.ts` matches the
// `unit` project glob (`lib/**/__tests__/**/*.test.ts`).
//
// Frozen interface (architect-fixed — ADR-066, plan T2.2):
//   export const shikiDiffHighlighter: DiffHighlighter — a `DiffHighlighter`-
//   shaped object the git-diff-view core consumes. At least:
//     name: "shiki"
//     type: "style"
//     maxLineToIgnoreSyntax: number
//     getAST(raw, fileName?, lang?, theme?): Root  (a hast Root)
//     processAST(ast): { ... }
//     hasRegisteredCurrentLang(lang: string): boolean
//   It reuses the shared Shiki singleton; the Implementor adds
//   `preloadDiffLangs(langs)` (+ `codeToHastSync`) to `lib/highlight/shiki.ts`,
//   so the adapter's `getAST` can run SYNCHRONOUSLY against a preloaded grammar
//   (git-diff-view calls `getAST` synchronously inside its build path).
//
// Assertions are BEHAVIOR-focused and resilient to git-diff-view / Shiki
// internals — we assert the hast Root SHAPE (`type === "root"`, has `children`),
// NOT a specific child structure or token tree.

import { describe, expect, it } from "vitest";

import { preloadDiffLangs } from "@/lib/highlight/shiki";
import { shikiDiffHighlighter } from "@/lib/diff/shiki-adapter";

describe("shikiDiffHighlighter — DiffHighlighter shape (ADR-066 T2.2)", () => {
  it("exposes the DiffHighlighter contract fields git-diff-view consumes", () => {
    expect(shikiDiffHighlighter.name).toBe("shiki");
    // The adapter highlights via inline styles (CSS-var dual-theme), NOT class
    // names — git-diff-view branches on `type` to pick the render path.
    expect(shikiDiffHighlighter.type).toBe("style");
    expect(typeof shikiDiffHighlighter.maxLineToIgnoreSyntax).toBe("number");
    expect(typeof shikiDiffHighlighter.getAST).toBe("function");
    expect(typeof shikiDiffHighlighter.processAST).toBe("function");
    expect(typeof shikiDiffHighlighter.hasRegisteredCurrentLang).toBe(
      "function",
    );
  });
});

describe("shikiDiffHighlighter.getAST — hast Root for a preloaded lang", () => {
  it("returns a non-empty hast Root after the grammar is preloaded", async () => {
    // git-diff-view's build path calls `getAST` synchronously, so the grammar
    // MUST be preloaded first. The highlight module exposes the preload the
    // adapter relies on.
    await preloadDiffLangs(["typescript"]);

    const ast = shikiDiffHighlighter.getAST(
      "const x = 1;",
      "a.ts",
      "typescript",
    );

    // Resilient shape check: a hast Root (`type: "root"`) with children — NOT a
    // specific token tree (which is a Shiki internal).
    expect(ast).toBeTruthy();
    expect(ast.type).toBe("root");
    expect(Array.isArray(ast.children)).toBe(true);
    expect(ast.children.length).toBeGreaterThan(0);
  });

  it("reports a preloaded lang via hasRegisteredCurrentLang", async () => {
    await preloadDiffLangs(["typescript"]);

    expect(shikiDiffHighlighter.hasRegisteredCurrentLang("typescript")).toBe(
      true,
    );
  });
});
