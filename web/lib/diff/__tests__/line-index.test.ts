// Track 1E (PERF-11, EDGE-PERF-09): parity and edge-case tests for the pure
// unified-diff line-index parser (`web/lib/diff/line-index.ts`).
//
// Verifies byte-for-byte parity against real `prepareDiff` (`@git-diff-view/core`)
// with `anchor.ts`'s exact trailing-LF normalization so review-comment anchoring
// can decouple from Shiki WASM without drifting from what the diff view renders.

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { parseDiffLineIndex } from "@/lib/diff/line-index";
import { prepareDiff } from "@/lib/diff/prepare";
import {
  parsePath,
  repoRelPath,
  unescapeGitQuotedPath,
} from "@/lib/diff/sections";

const withFinalNewline = (lines: string[]): string => `${lines.join("\n")}\n`;

// Mirrors `stripTrailingNewline` in `web/lib/review-comments/anchor.ts`.
function stripTrailingLf(text: string): string {
  return text.endsWith("\n") ? text.slice(0, -1) : text;
}

async function assertParityWithPrepareDiff(
  rawDiff: string,
  truncated = false,
): Promise<ReturnType<typeof parseDiffLineIndex>> {
  const [prepared, indexed] = await Promise.all([
    prepareDiff(rawDiff, truncated),
    Promise.resolve(parseDiffLineIndex(rawDiff, truncated)),
  ]);

  expect(indexed.truncated).toBe(prepared.truncated);
  expect([...indexed.files.keys()]).toEqual(
    prepared.perFile.map((file) => file.path),
  );

  for (const preparedFile of prepared.perFile) {
    const fileIndex = indexed.files.get(preparedFile.path);

    expect(fileIndex).toBeDefined();
    expect(fileIndex?.path).toBe(preparedFile.path);

    const expectedOld = new Map<number, string>();

    for (const [lineNo, item] of Object.entries(
      preparedFile.bundle.oldFileDiffLines,
    )) {
      expectedOld.set(Number(lineNo), stripTrailingLf(item.text));
    }

    const expectedNew = new Map<number, string>();

    for (const [lineNo, item] of Object.entries(
      preparedFile.bundle.newFileDiffLines,
    )) {
      expectedNew.set(Number(lineNo), stripTrailingLf(item.text));
    }

    expect(fileIndex?.oldLines).toEqual(expectedOld);
    expect(fileIndex?.newLines).toEqual(expectedNew);
  }

  return indexed;
}

describe("parseDiffLineIndex — parity with prepareDiff", () => {
  it("matches prepareDiff byte-for-byte across multi-hunk, multi-file diffs", async () => {
    const diff = withFinalNewline([
      "diff --git a/src/calc.ts b/src/calc.ts",
      "index 1111111..2222222 100644",
      "--- a/src/calc.ts",
      "+++ b/src/calc.ts",
      "@@ -1,3 +1,4 @@ export function header()",
      " const keep = 1;",
      "-const removed = 2;",
      "+const added = 2;",
      "+",
      " const tail = 3;",
      "@@ -20,2 +21,4 @@",
      "-const single = 0;",
      "---not-a-header",
      "+const single = 1;",
      "+++not-a-header",
      "+const plusPrefix = '++literal';",
      "+const minusPrefix = '--literal';",
      "diff --git a/src/second.ts b/src/second.ts",
      "index 3333333..4444444 100644",
      "--- a/src/second.ts",
      "+++ b/src/second.ts",
      "@@ -5,2 +5,2 @@",
      "-export const oldVal = 'a';",
      "+export const newVal = 'b';",
      " export const keepVal = 'c';",
      "@@ -40,2 +40,3 @@",
      " function end() {",
      "+  return true;",
      " }",
    ]);

    const indexed = await assertParityWithPrepareDiff(diff);

    expect(indexed.files.size).toBe(2);
    expect(indexed.files.get("src/calc.ts")?.newLines.get(3)).toBe("");
    expect(indexed.files.get("src/calc.ts")?.newLines.get(4)).toBe(
      "const tail = 3;",
    );
    expect(indexed.files.get("src/calc.ts")?.oldLines.get(21)).toBe(
      "--not-a-header",
    );
    expect(indexed.files.get("src/calc.ts")?.newLines.get(22)).toBe(
      "++not-a-header",
    );
    expect(indexed.files.get("src/calc.ts")?.newLines.get(23)).toBe(
      "const plusPrefix = '++literal';",
    );
    expect(indexed.files.get("src/second.ts")?.newLines.get(41)).toBe(
      "  return true;",
    );
  });

  it("preserves CRLF CR bytes and significant trailing spaces (including final data line)", async () => {
    const crlfDiff = withFinalNewline([
      "",
      "diff --git a/win.txt b/win.txt",
      "index 7777777..8888888 100644",
      "--- a/win.txt",
      "+++ b/win.txt",
      "@@ -1,3 +1,3 @@",
      "-old win\r",
      "+new win\r",
      " ctx win\r",
      "+last crlf\r",
    ]);

    const crlfIndexed = await assertParityWithPrepareDiff(`${crlfDiff}\n`);

    expect(crlfIndexed.files.get("win.txt")?.oldLines.get(1)).toBe("old win\r");
    expect(crlfIndexed.files.get("win.txt")?.newLines.get(1)).toBe("new win\r");
    expect(crlfIndexed.files.get("win.txt")?.newLines.get(2)).toBe("ctx win\r");
    expect(crlfIndexed.files.get("win.txt")?.newLines.get(3)).toBe(
      "last crlf\r",
    );

    const trailingSpacesDiff = withFinalNewline([
      "diff --git a/pad.ts b/pad.ts",
      "index 5555555..6666666 100644",
      "--- a/pad.ts",
      "+++ b/pad.ts",
      "@@ -1,2 +1,2 @@",
      "-const p = 1;",
      "+const p = 1;  ",
      " const q = 2;   ",
    ]);

    const padIndexed = await assertParityWithPrepareDiff(trailingSpacesDiff);

    expect(padIndexed.files.get("pad.ts")?.newLines.get(1)).toBe(
      "const p = 1;  ",
    );
    expect(padIndexed.files.get("pad.ts")?.oldLines.get(2)).toBe(
      "const q = 2;   ",
    );
    expect(padIndexed.files.get("pad.ts")?.newLines.get(2)).toBe(
      "const q = 2;   ",
    );
  });

  it("handles '\\ No newline at end of file' on old, new, and both sides", async () => {
    const diff = withFinalNewline([
      "diff --git a/old-no-nl.txt b/old-no-nl.txt",
      "index 1111111..2222222 100644",
      "--- a/old-no-nl.txt",
      "+++ b/old-no-nl.txt",
      "@@ -1,2 +1,2 @@",
      " keep",
      "-old last",
      "\\ No newline at end of file",
      "+new last",
      "diff --git a/new-no-nl.txt b/new-no-nl.txt",
      "index 3333333..4444444 100644",
      "--- a/new-no-nl.txt",
      "+++ b/new-no-nl.txt",
      "@@ -1,2 +1,2 @@",
      " keep",
      "-old last",
      "+new last",
      "\\ No newline at end of file",
      "diff --git a/both-no-nl.txt b/both-no-nl.txt",
      "index 5555555..6666666 100644",
      "--- a/both-no-nl.txt",
      "+++ b/both-no-nl.txt",
      "@@ -1,2 +1,2 @@",
      " keep",
      "-old last",
      "\\ No newline at end of file",
      "+new last",
      "\\ No newline at end of file",
      "diff --git a/ctx-no-nl.txt b/ctx-no-nl.txt",
      "index 7777777..8888888 100644",
      "--- a/ctx-no-nl.txt",
      "+++ b/ctx-no-nl.txt",
      "@@ -1,2 +1,2 @@",
      "-first old",
      "+first new",
      " tail ctx",
      "\\ No newline at end of file",
    ]);

    const indexed = await assertParityWithPrepareDiff(diff);

    expect(indexed.files.get("old-no-nl.txt")?.oldLines.get(2)).toBe(
      "old last",
    );
    expect(indexed.files.get("old-no-nl.txt")?.newLines.get(2)).toBe(
      "new last",
    );
    expect(indexed.files.get("new-no-nl.txt")?.newLines.get(2)).toBe(
      "new last",
    );
    expect(indexed.files.get("both-no-nl.txt")?.oldLines.get(2)).toBe(
      "old last",
    );
    expect(indexed.files.get("both-no-nl.txt")?.newLines.get(2)).toBe(
      "new last",
    );
    expect(indexed.files.get("ctx-no-nl.txt")?.oldLines.get(2)).toBe(
      "tail ctx",
    );
    expect(indexed.files.get("ctx-no-nl.txt")?.newLines.get(2)).toBe(
      "tail ctx",
    );
  });

  it("handles empty context lines (both single-space and bare empty lines) inside hunks", async () => {
    const diff = withFinalNewline([
      "diff --git a/blank-ctx.ts b/blank-ctx.ts",
      "index 1111111..2222222 100644",
      "--- a/blank-ctx.ts",
      "+++ b/blank-ctx.ts",
      "@@ -1,5 +1,6 @@",
      " const a = 1;",
      " ",
      "",
      "-const b = 2;",
      "+const b = 3;",
      "+const c = 4;",
      " const d = 5;",
    ]);

    const indexed = await assertParityWithPrepareDiff(diff);
    const file = indexed.files.get("blank-ctx.ts");

    expect(file?.oldLines.get(2)).toBe("");
    expect(file?.newLines.get(2)).toBe("");
    expect(file?.oldLines.get(3)).toBe("");
    expect(file?.newLines.get(3)).toBe("");
    expect(file?.oldLines.get(5)).toBe("const d = 5;");
    expect(file?.newLines.get(6)).toBe("const d = 5;");
  });

  it("handles renamed, added, deleted, binary, and quoted-header files identically to prepareDiff", async () => {
    const diff = withFinalNewline([
      "diff --git a/src/old-name.ts b/src/new-name.ts",
      "similarity index 80%",
      "rename from src/old-name.ts",
      "rename to src/new-name.ts",
      "index 1111111..2222222 100644",
      "--- a/src/old-name.ts",
      "+++ b/src/new-name.ts",
      "@@ -1,2 +1,2 @@",
      "-export const x = 1;",
      "+export const x = 2;",
      " export const y = 3;",
      "diff --git a/src/pure-old.ts b/src/pure-new.ts",
      "similarity index 100%",
      "rename from src/pure-old.ts",
      "rename to src/pure-new.ts",
      "diff --git a/notes/added.md b/notes/added.md",
      "new file mode 100644",
      "index 0000000..3333333",
      "--- /dev/null",
      "+++ b/notes/added.md",
      "@@ -0,0 +1,2 @@",
      "+# Title",
      "+Body",
      "diff --git a/notes/deleted.md b/notes/deleted.md",
      "deleted file mode 100644",
      "index 4444444..0000000",
      "--- a/notes/deleted.md",
      "+++ /dev/null",
      "@@ -1,2 +0,0 @@",
      "-# Gone",
      "-Line 2",
      "diff --git a/assets/logo.png b/assets/logo.png",
      "index 5555555..6666666 100644",
      "Binary files a/assets/logo.png and b/assets/logo.png differ",
      'diff --git "a/dir/my file.ts" "b/dir/my file.ts"',
      "index 7777777..8888888 100644",
      '--- "a/dir/my file.ts"',
      '+++ "b/dir/my file.ts"',
      "@@ -1 +1 @@",
      "-const q = 1;",
      "+const q = 2;",
      'diff --git "a/\\320\\277\\321\\200\\320\\270\\320\\262\\320\\265\\321\\202.ts" "b/\\320\\277\\321\\200\\320\\270\\320\\262\\320\\265\\321\\202.ts"',
      "index 8888888..9999999 100644",
      '--- "a/\\320\\277\\321\\200\\320\\270\\320\\262\\320\\265\\321\\202.ts"',
      '+++ "b/\\320\\277\\321\\200\\320\\270\\320\\262\\320\\265\\321\\202.ts"',
      "@@ -1 +1 @@",
      "-const ru = 1;",
      "+const ru = 2;",
    ]);

    const indexed = await assertParityWithPrepareDiff(diff);

    expect(indexed.files.has("src/old-name.ts")).toBe(false);
    expect(indexed.files.get("src/new-name.ts")?.newLines.get(1)).toBe(
      "export const x = 2;",
    );
    expect(indexed.files.get("src/pure-new.ts")?.oldLines.size).toBe(0);
    expect(indexed.files.get("src/pure-new.ts")?.newLines.size).toBe(0);
    expect(indexed.files.get("notes/added.md")?.oldLines.size).toBe(0);
    expect(indexed.files.get("notes/added.md")?.newLines.get(2)).toBe("Body");
    expect(indexed.files.get("notes/deleted.md")?.oldLines.get(1)).toBe(
      "# Gone",
    );
    expect(indexed.files.get("notes/deleted.md")?.newLines.size).toBe(0);
    expect(indexed.files.get("assets/logo.png")?.oldLines.size).toBe(0);
    expect(indexed.files.get("assets/logo.png")?.newLines.size).toBe(0);
    expect(indexed.files.get("dir/my file.ts")?.oldLines.get(1)).toBe(
      "const q = 1;",
    );
    expect(indexed.files.get("dir/my file.ts")?.newLines.get(1)).toBe(
      "const q = 2;",
    );
    expect(indexed.files.get("привет.ts")?.oldLines.get(1)).toBe(
      "const ru = 1;",
    );
    expect(indexed.files.get("привет.ts")?.newLines.get(1)).toBe(
      "const ru = 2;",
    );
  });

  it("matches prepareDiff when a bare empty line appears right before the next diff --git section", async () => {
    const diff = withFinalNewline([
      "diff --git a/first.ts b/first.ts",
      "index 1111111..2222222 100644",
      "--- a/first.ts",
      "+++ b/first.ts",
      "@@ -1,2 +1,2 @@",
      "-const a = 1;",
      "+const a = 2;",
      "",
      "diff --git a/second.ts b/second.ts",
      "index 3333333..4444444 100644",
      "--- a/second.ts",
      "+++ b/second.ts",
      "@@ -1 +1 @@",
      "-const b = 1;",
      "+const b = 2;",
    ]);

    const indexed = await assertParityWithPrepareDiff(diff);

    expect(indexed.files.get("first.ts")?.oldLines).toEqual(
      new Map([[1, "const a = 1;"]]),
    );
    expect(indexed.files.get("first.ts")?.newLines).toEqual(
      new Map([[1, "const a = 2;"]]),
    );
    expect(indexed.files.get("second.ts")?.newLines.get(1)).toBe(
      "const b = 2;",
    );
  });

  it("handles empty/whitespace diffs and propagates truncated flag", async () => {
    const empty = await assertParityWithPrepareDiff("");

    expect(empty.files.size).toBe(0);
    expect(empty.truncated).toBe(false);

    const emptyTruncated = await assertParityWithPrepareDiff("", true);

    expect(emptyTruncated.files.size).toBe(0);
    expect(emptyTruncated.truncated).toBe(true);

    const whitespaceOnly = await assertParityWithPrepareDiff("   \n\n  ");

    expect(whitespaceOnly.files.size).toBe(0);
    expect(whitespaceOnly.truncated).toBe(false);

    const truncatedNonEmpty = await assertParityWithPrepareDiff(
      withFinalNewline([
        "diff --git a/a.ts b/a.ts",
        "index 1111111..2222222 100644",
        "--- a/a.ts",
        "+++ b/a.ts",
        "@@ -1 +1 @@",
        "-old",
        "+new",
      ]),
      true,
    );

    expect(truncatedNonEmpty.truncated).toBe(true);
    expect(truncatedNonEmpty.files.get("a.ts")?.newLines.get(1)).toBe("new");
  });
});

describe("parseDiffLineIndex — resilience & import isolation", () => {
  it("skips a malformed hunk header safely without throwing and indexes subsequent valid hunks", () => {
    const diff = withFinalNewline([
      "diff --git a/broken.ts b/broken.ts",
      "index 1111111..2222222 100644",
      "--- a/broken.ts",
      "+++ b/broken.ts",
      "@@ -not,a +valid,hunk @@",
      "-should be skipped",
      "+also skipped",
      "@@ -10,2 +10,2 @@",
      "-const before = 1;",
      "+const after = 2;",
      " const keep = 3;",
    ]);

    const indexed = parseDiffLineIndex(diff);
    const file = indexed.files.get("broken.ts");

    expect(file).toBeDefined();
    expect(file?.oldLines).toEqual(
      new Map([
        [10, "const before = 1;"],
        [11, "const keep = 3;"],
      ]),
    );
    expect(file?.newLines).toEqual(
      new Map([
        [10, "const after = 2;"],
        [11, "const keep = 3;"],
      ]),
    );
  });

  it("has zero imports of shiki or @git-diff-view/core", () => {
    const sourcePath = path.resolve(__dirname, "../line-index.ts");
    const source = readFileSync(sourcePath, "utf8");
    const sectionsPath = path.resolve(__dirname, "../sections.ts");
    const sectionsSource = readFileSync(sectionsPath, "utf8");

    expect(source).toContain('import "server-only"');
    expect(source).not.toMatch(/from\s+["'][^"']*shiki[^"']*["']/);
    expect(source).not.toMatch(/import\s+["'][^"']*shiki[^"']*["']/);
    expect(source).not.toMatch(/from\s+["']@git-diff-view\/core["']/);
    expect(source).not.toMatch(/import\s+["']@git-diff-view\/core["']/);
    expect(sectionsSource).not.toMatch(/from\s+["'][^"']*shiki[^"']*["']/);
    expect(sectionsSource).not.toMatch(/from\s+["']@git-diff-view\/core["']/);
    expect(sectionsSource).not.toMatch(/from\s+["']node:/);
  });

  it("unescapes git C-quoted paths with quotes, backslashes, tabs, newlines, and octal UTF-8", () => {
    expect(unescapeGitQuotedPath("plain/path.ts")).toBe("plain/path.ts");
    expect(unescapeGitQuotedPath('"a/dir/my file.ts"')).toBe(
      "a/dir/my file.ts",
    );
    expect(repoRelPath('"b/dir/my file.ts"')).toBe("dir/my file.ts");
    expect(
      unescapeGitQuotedPath(
        '"b/\\320\\277\\321\\200\\320\\270\\320\\262\\320\\265\\321\\202.ts"',
      ),
    ).toBe("b/привет.ts");
    expect(unescapeGitQuotedPath('"a/quote\\"back\\\\tab\\tline\\n.ts"')).toBe(
      'a/quote"back\\tab\tline\n.ts',
    );
    expect(
      parsePath('diff --git "a/dir/my file.ts" "b/dir/my file.ts"', []),
    ).toBe("dir/my file.ts");
    expect(
      parsePath("diff --git a/old.ts b/new.ts", ['+++ "b/dir/my file.ts"']),
    ).toBe("dir/my file.ts");
  });
});
