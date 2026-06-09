// Phase 1 (T1.2, RED): failing contract tests for the server-only Shiki
// highlight core. The module `web/lib/highlight/shiki.ts` does not exist yet —
// these tests RED on the missing import (`@/lib/highlight/shiki`).
//
// Style: node env, no jsdom; the async highlighter is awaited DIRECTLY (no
// React), mirroring the repo's pure-helper unit tests under lib/**/__tests__.
// `.test.ts` matches the `unit` project glob (`lib/**/__tests__/**/*.test.ts`).
//
// Frozen interface (architect-fixed — ADR-066, plan T1.2):
//   export function langFromPath(path: string): string
//     — maps a file path to a Shiki language id by extension; unknown / no
//       extension → "plaintext".
//   export async function highlightToHtml(code: string, lang: string): Promise<string>
//     — dual-theme highlighted HTML (line numbers); unknown lang MUST NOT throw
//       and falls back to (HTML-escaped) plaintext.
//
// These assertions are BEHAVIOR/CONTRACT-focused, NOT tied to Shiki internals,
// so any reasonable dual-theme implementation passes:
//   - known extension → a non-"plaintext" lang id
//   - unknown / extensionless → "plaintext"
//   - highlightToHtml(known) → non-empty HTML that CONTAINS the source token
//     AND carries dual-theme markers (inline `style=` with `--shiki` CSS vars)
//     AND splits the source into per-line elements (line-number structure)
//   - highlightToHtml(unknown lang) → no throw, still returns the escaped code

import { describe, expect, it } from "vitest";

import { highlightToHtml, langFromPath } from "@/lib/highlight/shiki";

describe("langFromPath — extension → Shiki language id", () => {
  it("maps known source extensions to a non-plaintext language id", () => {
    // Behavior contract: each known extension resolves to *some* highlightable
    // lang id (not the plaintext fallback). We do not pin the exact id string
    // beyond the few stable Shiki ids the plan enumerates, to stay resilient.
    const knownPaths = [
      "a.ts",
      "a.tsx",
      "a.js",
      "x.py",
      "f.json",
      "r.md",
      "s.sh",
    ];

    for (const path of knownPaths) {
      const lang = langFromPath(path);

      expect(lang).not.toBe("plaintext");
      expect(lang.length).toBeGreaterThan(0);
    }
  });

  it("maps .ts → typescript", () => {
    expect(langFromPath("a.ts")).toBe("typescript");
  });

  it("maps .tsx → tsx", () => {
    expect(langFromPath("a.tsx")).toBe("tsx");
  });

  it("maps .js → javascript", () => {
    expect(langFromPath("a.js")).toBe("javascript");
  });

  it("maps .py → python", () => {
    expect(langFromPath("x.py")).toBe("python");
  });

  it("maps .json → json", () => {
    expect(langFromPath("f.json")).toBe("json");
  });

  it("maps .md → markdown", () => {
    expect(langFromPath("r.md")).toBe("markdown");
  });

  it("maps .sh → a shell lang id (shell or bash)", () => {
    // Shiki accepts both `shell` and `bash` as ids/aliases — accept either.
    expect(["shell", "bash"]).toContain(langFromPath("s.sh"));
  });

  it("maps a deep path by its trailing extension", () => {
    expect(langFromPath("src/nested/dir/component.tsx")).toBe("tsx");
  });

  it("falls back to plaintext for an unknown extension", () => {
    expect(langFromPath("unknown.xyz")).toBe("plaintext");
  });

  it("falls back to plaintext for a path with no extension", () => {
    expect(langFromPath("Makefile")).toBe("plaintext");
  });

  it("falls back to plaintext for a dotfile with no real extension", () => {
    // A leading-dot name like ".gitignore" has no trailing source extension.
    expect(langFromPath(".gitignore")).toBe("plaintext");
  });
});

describe("highlightToHtml — dual-theme highlighting (known lang)", () => {
  it("returns non-empty HTML containing the source token", async () => {
    const html = await highlightToHtml("const x = 1;", "typescript");

    expect(typeof html).toBe("string");
    expect(html.length).toBeGreaterThan(0);
    expect(html).toContain("const");
  });

  it("carries dual-theme styling markers (inline --shiki CSS variables)", async () => {
    const html = await highlightToHtml("const x = 1;", "typescript");

    // Shiki dual-theme (defaultColor:false) emits inline `style` attributes
    // carrying `--shiki*` CSS custom properties so the theme switches on the
    // `.light`/`.dark` class WITHOUT re-highlighting. Assert on the presence of
    // the dual-theme marker, not on exact colors.
    expect(html).toContain("style=");
    expect(html).toContain("--shiki");
  });

  it("renders per-line structure (line-number wrappers)", async () => {
    // The Implementor renders line numbers → the source is split into per-line
    // elements. Assert multi-line input yields multiple line elements rather
    // than a specific class name (resilient to the chosen wrapper).
    const code = ["const a = 1;", "const b = 2;", "const c = 3;"].join("\n");
    const html = await highlightToHtml(code, "typescript");

    const lineCount = (html.match(/class="[^"]*line[^"]*"/g) ?? []).length;

    expect(lineCount).toBeGreaterThanOrEqual(3);

    // IMPLEMENTOR FIX (objectively-wrong expectation): a real tokenizing
    // highlighter (Shiki) wraps each TOKEN in its own <span>, so a whole source
    // line is NOT a contiguous substring of the markup. The faithful intent —
    // "the source text is rendered" — is asserted against the tag-stripped text.
    const text = html.replace(/<[^>]+>/g, "");

    expect(text).toContain("const a = 1;");
    expect(text).toContain("const c = 3;");
  });
});

describe("highlightToHtml — plaintext fallback (unknown lang)", () => {
  it("does not throw and still returns the code for an unknown lang", async () => {
    const code = "totally arbitrary text 123";
    const html = await highlightToHtml(code, "xyzlang");

    expect(typeof html).toBe("string");
    expect(html.length).toBeGreaterThan(0);
    expect(html).toContain("arbitrary text 123");
  });

  it("HTML-escapes special characters in the plaintext fallback", async () => {
    // Unknown lang → plaintext path MUST still escape, never inject raw markup.
    const html = await highlightToHtml("a < b && c > d", "xyzlang");

    // IMPLEMENTOR FIX (objectively-wrong expectation): Shiki escapes via numeric
    // hex entities, not named ones — `<` -> `&#x3C;`, `&` -> `&#x26;` (`>` is
    // left literal, which is valid + safe in text content). The load-bearing
    // security contract — no raw `<` that could open a tag — is unchanged.
    expect(html).toContain("&#x3C;"); // `<` is HTML-escaped
    expect(html).toContain("&#x26;"); // `&` is HTML-escaped
    expect(html).not.toContain("a < b"); // no raw markup injected
    expect(html).not.toContain("< b"); // `<` never appears unescaped
  });
});
