// Task 5 (TDD): contract tests for `web/lib/review-comments/anchor.ts` — pure
// anchor extraction (POST-time) + placement matching (GET-time) over the
// server-prepared diff (ADR-071, docs/system-analytics/review-comments.md).
//
// Fixtures are realistic raw unified diffs pushed through the REAL production
// parse path (`prepareDiff` -> @git-diff-view/core), never hand-mocked parsed
// structures — the anchor source must be exactly what the diff view renders
// (`components/workbench/diff-view.tsx` hydrates the same bundles).
//
// Semantics pinned here:
//   - `side`: "old" = base half, "new" = branch half; `line` is the 1-based
//     file line number on that side (the diff widget's (lineNumber, SplitSide)).
//   - context lines are anchorable from EITHER side; their old/new line
//     numbers may differ within a hunk.
//   - extraction refuses a truncated diff (route maps to PRECONDITION);
//     placement instead matches against the surviving prefix (GET still works).
//   - placement = "inline" iff byte-exact content at the exact (file, side,
//     line) in the CURRENT diff; edited/moved/gone -> "outdated", no fuzzy
//     re-anchoring.

import { describe, expect, it } from "vitest";

import { prepareDiff } from "@/lib/diff/prepare";
import {
  computePlacement,
  extractAnchorContent,
} from "@/lib/review-comments/anchor";

// Every fixture ends with "\n" like real `git diff` stdout: prepareDiff's
// splitSections trims the raw text, so trailing-whitespace-significant lines
// must never be the physical last line of the diff (they never are in git
// output, which always terminates with a newline).
const withFinalNewline = (lines: string[]): string => `${lines.join("\n")}\n`;

// src/calc.ts hunk line map:
//   ctx "const keep = 1;"    old 10 / new 10
//   del "const removed = 2;" old 11
//   add "const added = 2;"   new 11
//   add ""                   new 12
//   ctx "const tail = 3;"    old 12 / new 13
// notes/readme.md: added file, new 1-2.
const BASE_DIFF = withFinalNewline([
  "diff --git a/src/calc.ts b/src/calc.ts",
  "index 1111111..2222222 100644",
  "--- a/src/calc.ts",
  "+++ b/src/calc.ts",
  "@@ -10,3 +10,4 @@",
  " const keep = 1;",
  "-const removed = 2;",
  "+const added = 2;",
  "+",
  " const tail = 3;",
  "diff --git a/notes/readme.md b/notes/readme.md",
  "new file mode 100644",
  "index 0000000..3333333",
  "--- /dev/null",
  "+++ b/notes/readme.md",
  "@@ -0,0 +1,2 @@",
  "+# Readme",
  "+line two",
]);

// Same positions as BASE_DIFF, but the added line's CONTENT changed.
const EDITED_DIFF = withFinalNewline([
  "diff --git a/src/calc.ts b/src/calc.ts",
  "index 1111111..9999999 100644",
  "--- a/src/calc.ts",
  "+++ b/src/calc.ts",
  "@@ -10,3 +10,4 @@",
  " const keep = 1;",
  "-const removed = 2;",
  "+const added = 99;",
  "+",
  " const tail = 3;",
]);

// "const added = 2;" still exists but an insertion above pushed it from
// new 11 to new 12 — must be OUTDATED at new 11 (no fuzzy re-anchoring).
const SHIFTED_DIFF = withFinalNewline([
  "diff --git a/src/calc.ts b/src/calc.ts",
  "index 1111111..8888888 100644",
  "--- a/src/calc.ts",
  "+++ b/src/calc.ts",
  "@@ -10,3 +10,5 @@",
  " const keep = 1;",
  "-const removed = 2;",
  "+const inserted = 0;",
  "+const added = 2;",
  "+",
  " const tail = 3;",
]);

// src/calc.ts is still in the diff, but its only hunk covers other lines.
const LINE_GONE_DIFF = withFinalNewline([
  "diff --git a/src/calc.ts b/src/calc.ts",
  "index 1111111..7777777 100644",
  "--- a/src/calc.ts",
  "+++ b/src/calc.ts",
  "@@ -100,2 +100,3 @@",
  " const z = 9;",
  "+const z2 = 10;",
  " const y = 8;",
]);

// src/calc.ts dropped out of the diff entirely (e.g. rework reverted it).
const FILE_GONE_DIFF = withFinalNewline([
  "diff --git a/notes/readme.md b/notes/readme.md",
  "new file mode 100644",
  "index 0000000..3333333",
  "--- /dev/null",
  "+++ b/notes/readme.md",
  "@@ -0,0 +1,2 @@",
  "+# Readme",
  "+line two",
]);

// New-side line 1 carries exactly two trailing spaces; the trailing context
// line keeps it interior (the physical last diff line is trim-affected).
const PAD_DIFF = withFinalNewline([
  "diff --git a/pad.ts b/pad.ts",
  "index 5555555..6666666 100644",
  "--- a/pad.ts",
  "+++ b/pad.ts",
  "@@ -1,2 +1,2 @@",
  "-const p = 1;",
  "+const p = 1;  ",
  " const q = 2;",
]);

// CRLF file: data lines end "\r\n" in the patch, so the content keeps the CR.
const CRLF_DIFF = withFinalNewline([
  "diff --git a/win.txt b/win.txt",
  "index 7777777..8888888 100644",
  "--- a/win.txt",
  "+++ b/win.txt",
  "@@ -1,2 +1,2 @@",
  "-old win\r",
  "+new win\r",
  " ctx win\r",
]);

// Same change with LF endings — differs from CRLF_DIFF only by the CR bytes.
const LF_DIFF = withFinalNewline([
  "diff --git a/win.txt b/win.txt",
  "index 7777777..8888888 100644",
  "--- a/win.txt",
  "+++ b/win.txt",
  "@@ -1,2 +1,2 @@",
  "-old win",
  "+new win",
  " ctx win",
]);

describe("extractAnchorContent — POST-time extraction", () => {
  it("extracts an added line on the new side", async () => {
    const prepared = await prepareDiff(BASE_DIFF);

    expect(
      extractAnchorContent(prepared, {
        filePath: "src/calc.ts",
        side: "new",
        line: 11,
      }),
    ).toEqual({ ok: true, lineContent: "const added = 2;" });
  });

  it("extracts a deleted line on the old side", async () => {
    const prepared = await prepareDiff(BASE_DIFF);

    expect(
      extractAnchorContent(prepared, {
        filePath: "src/calc.ts",
        side: "old",
        line: 11,
      }),
    ).toEqual({ ok: true, lineContent: "const removed = 2;" });
  });

  it("extracts a context line from EITHER side, with per-side line numbers", async () => {
    const prepared = await prepareDiff(BASE_DIFF);

    expect(
      extractAnchorContent(prepared, {
        filePath: "src/calc.ts",
        side: "old",
        line: 10,
      }),
    ).toEqual({ ok: true, lineContent: "const keep = 1;" });
    expect(
      extractAnchorContent(prepared, {
        filePath: "src/calc.ts",
        side: "new",
        line: 10,
      }),
    ).toEqual({ ok: true, lineContent: "const keep = 1;" });

    // The trailing context line shifted: old 12 ≡ new 13.
    expect(
      extractAnchorContent(prepared, {
        filePath: "src/calc.ts",
        side: "old",
        line: 12,
      }),
    ).toEqual({ ok: true, lineContent: "const tail = 3;" });
    expect(
      extractAnchorContent(prepared, {
        filePath: "src/calc.ts",
        side: "new",
        line: 13,
      }),
    ).toEqual({ ok: true, lineContent: "const tail = 3;" });
  });

  it("extracts the empty string for an added blank line (legit content)", async () => {
    const prepared = await prepareDiff(BASE_DIFF);

    expect(
      extractAnchorContent(prepared, {
        filePath: "src/calc.ts",
        side: "new",
        line: 12,
      }),
    ).toEqual({ ok: true, lineContent: "" });
  });

  it("preserves trailing whitespace byte-exactly", async () => {
    const prepared = await prepareDiff(PAD_DIFF);

    expect(
      extractAnchorContent(prepared, {
        filePath: "pad.ts",
        side: "new",
        line: 1,
      }),
    ).toEqual({ ok: true, lineContent: "const p = 1;  " });
    expect(
      extractAnchorContent(prepared, {
        filePath: "pad.ts",
        side: "old",
        line: 1,
      }),
    ).toEqual({ ok: true, lineContent: "const p = 1;" });
  });

  it("preserves the CR of a CRLF file (strips only the trailing LF)", async () => {
    const prepared = await prepareDiff(CRLF_DIFF);

    expect(
      extractAnchorContent(prepared, {
        filePath: "win.txt",
        side: "old",
        line: 1,
      }),
    ).toEqual({ ok: true, lineContent: "old win\r" });
    expect(
      extractAnchorContent(prepared, {
        filePath: "win.txt",
        side: "new",
        line: 1,
      }),
    ).toEqual({ ok: true, lineContent: "new win\r" });
  });

  it("reports line_absent when the line is not on that side of the diff", async () => {
    const prepared = await prepareDiff(BASE_DIFF);

    // Beyond the hunk.
    expect(
      extractAnchorContent(prepared, {
        filePath: "src/calc.ts",
        side: "new",
        line: 999,
      }),
    ).toEqual({ ok: false, reason: "line_absent" });

    // new 13 exists (context), but old 13 does not.
    expect(
      extractAnchorContent(prepared, {
        filePath: "src/calc.ts",
        side: "old",
        line: 13,
      }),
    ).toEqual({ ok: false, reason: "line_absent" });

    // An added file has no old side at all.
    expect(
      extractAnchorContent(prepared, {
        filePath: "notes/readme.md",
        side: "old",
        line: 1,
      }),
    ).toEqual({ ok: false, reason: "line_absent" });
  });

  it("reports file_absent when the path is not in the parsed diff", async () => {
    const prepared = await prepareDiff(BASE_DIFF);

    expect(
      extractAnchorContent(prepared, {
        filePath: "src/missing.ts",
        side: "new",
        line: 1,
      }),
    ).toEqual({ ok: false, reason: "file_absent" });
  });

  it("refuses a truncated diff even when the position is in the surviving prefix", async () => {
    const prepared = await prepareDiff(BASE_DIFF, true);

    expect(
      extractAnchorContent(prepared, {
        filePath: "src/calc.ts",
        side: "new",
        line: 11,
      }),
    ).toEqual({ ok: false, reason: "diff_truncated" });
  });
});

describe("computePlacement — GET-time placement", () => {
  it("is inline when the current diff is identical (new, old, and context anchors)", async () => {
    const prepared = await prepareDiff(BASE_DIFF);

    expect(
      computePlacement(prepared, {
        filePath: "src/calc.ts",
        side: "new",
        line: 11,
        lineContent: "const added = 2;",
      }),
    ).toBe("inline");
    expect(
      computePlacement(prepared, {
        filePath: "src/calc.ts",
        side: "old",
        line: 11,
        lineContent: "const removed = 2;",
      }),
    ).toBe("inline");
    expect(
      computePlacement(prepared, {
        filePath: "src/calc.ts",
        side: "new",
        line: 13,
        lineContent: "const tail = 3;",
      }),
    ).toBe("inline");
  });

  it("is outdated when the content at the position was edited", async () => {
    const prepared = await prepareDiff(EDITED_DIFF);

    expect(
      computePlacement(prepared, {
        filePath: "src/calc.ts",
        side: "new",
        line: 11,
        lineContent: "const added = 2;",
      }),
    ).toBe("outdated");

    // The old half did not change — its anchor stays inline.
    expect(
      computePlacement(prepared, {
        filePath: "src/calc.ts",
        side: "old",
        line: 11,
        lineContent: "const removed = 2;",
      }),
    ).toBe("inline");
  });

  it("is outdated when the content moved down a line (no fuzzy re-anchoring)", async () => {
    const prepared = await prepareDiff(SHIFTED_DIFF);

    // Sanity: the stored content DOES exist one line below in the current diff…
    expect(
      extractAnchorContent(prepared, {
        filePath: "src/calc.ts",
        side: "new",
        line: 12,
      }),
    ).toEqual({ ok: true, lineContent: "const added = 2;" });

    // …yet the anchor matches positionally only: new 11 now holds other text.
    expect(
      computePlacement(prepared, {
        filePath: "src/calc.ts",
        side: "new",
        line: 11,
        lineContent: "const added = 2;",
      }),
    ).toBe("outdated");
  });

  it("is outdated when the anchored line left the diff (hunk moved away)", async () => {
    const prepared = await prepareDiff(LINE_GONE_DIFF);

    expect(
      computePlacement(prepared, {
        filePath: "src/calc.ts",
        side: "new",
        line: 11,
        lineContent: "const added = 2;",
      }),
    ).toBe("outdated");
  });

  it("is outdated when the file disappears from the diff (incl. empty diff)", async () => {
    const anchor = {
      filePath: "src/calc.ts",
      side: "new",
      line: 11,
      lineContent: "const added = 2;",
    } as const;

    expect(computePlacement(await prepareDiff(FILE_GONE_DIFF), anchor)).toBe(
      "outdated",
    );
    expect(computePlacement(await prepareDiff(""), anchor)).toBe("outdated");
  });

  it("matches empty-string content exactly (not treated as absent)", async () => {
    expect(
      computePlacement(await prepareDiff(BASE_DIFF), {
        filePath: "src/calc.ts",
        side: "new",
        line: 12,
        lineContent: "",
      }),
    ).toBe("inline");

    // In SHIFTED_DIFF, new 12 now carries real content — the "" anchor is stale.
    expect(
      computePlacement(await prepareDiff(SHIFTED_DIFF), {
        filePath: "src/calc.ts",
        side: "new",
        line: 12,
        lineContent: "",
      }),
    ).toBe("outdated");
  });

  it("treats trailing whitespace as significant (byte-exact match)", async () => {
    const prepared = await prepareDiff(PAD_DIFF);

    expect(
      computePlacement(prepared, {
        filePath: "pad.ts",
        side: "new",
        line: 1,
        lineContent: "const p = 1;",
      }),
    ).toBe("outdated");
    expect(
      computePlacement(prepared, {
        filePath: "pad.ts",
        side: "new",
        line: 1,
        lineContent: "const p = 1;  ",
      }),
    ).toBe("inline");
  });

  it("treats a CR as significant (CRLF vs LF never cross-match)", async () => {
    const crlfAnchor = {
      filePath: "win.txt",
      side: "new",
      line: 1,
      lineContent: "new win\r",
    } as const;

    expect(computePlacement(await prepareDiff(CRLF_DIFF), crlfAnchor)).toBe(
      "inline",
    );
    expect(computePlacement(await prepareDiff(LF_DIFF), crlfAnchor)).toBe(
      "outdated",
    );
  });

  it("matches against the surviving prefix of a truncated diff (GET still works)", async () => {
    // File still inside the prefix + content matches -> inline.
    expect(
      computePlacement(await prepareDiff(BASE_DIFF, true), {
        filePath: "src/calc.ts",
        side: "new",
        line: 11,
        lineContent: "const added = 2;",
      }),
    ).toBe("inline");

    // File fell past the bound -> outdated.
    expect(
      computePlacement(await prepareDiff(FILE_GONE_DIFF, true), {
        filePath: "src/calc.ts",
        side: "new",
        line: 11,
        lineContent: "const added = 2;",
      }),
    ).toBe("outdated");
  });
});
