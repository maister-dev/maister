import { describe, expect, it } from "vitest";

import { markdownExcerpt } from "@/lib/markdown-excerpt";

// Table transcribed from S1.2 of the plan. Rows 1-12 pin one derivation rule
// each; rows 13-17 pin the truncation boundary, including both sides of the
// word-boundary floor and the code-point (not UTF-16) measurement.

const WORD = "абвгдеж";
const PROSE = Array.from({ length: 25 }, () => WORD).join(" ");

const cases: {
  name: string;
  input: string;
  expected: string;
  truncated: boolean;
}[] = [
  {
    name: "01 plain prose is returned unchanged",
    input: "Fix the 500 on collect",
    expected: "Fix the 500 on collect",
    truncated: false,
  },
  { name: "02 empty source", input: "", expected: "", truncated: false },
  {
    name: "03 heading markers and blank lines collapse",
    input: "## Симптом\n\nВкладка артефактов",
    expected: "Симптом Вкладка артефактов",
    truncated: false,
  },
  {
    name: "04 emphasis markers are stripped, content kept",
    input: "**bold** and _italic_ and ~~strike~~",
    expected: "bold and italic and strike",
    truncated: false,
  },
  {
    name: "05 inline-code backticks are stripped",
    input: "Use `deriveFromToolCall` here",
    expected: "Use deriveFromToolCall here",
    truncated: false,
  },
  {
    name: "06 fence delimiters and info string are stripped",
    input: "```ts\nconst a = 1;\n```",
    expected: "const a = 1;",
    truncated: false,
  },
  {
    name: "07 a link reduces to its label",
    input: "[the projector](web/lib/x.ts)",
    expected: "the projector",
    truncated: false,
  },
  {
    name: "08 an image reduces to its alt text",
    input: "![diagram](a.png)",
    expected: "diagram",
    truncated: false,
  },
  {
    name: "09 blockquote markers are stripped",
    input: "> quoted line",
    expected: "quoted line",
    truncated: false,
  },
  {
    name: "10 unordered and ordered list markers are stripped",
    input: "- one\n- two\n1. three",
    expected: "one two three",
    truncated: false,
  },
  {
    name: "11 a GFM table keeps cell text and drops the alignment row",
    input: "| run | count |\n|---|---|\n| a | 1 |",
    expected: "run count a 1",
    truncated: false,
  },
  {
    name: "12 a horizontal rule is stripped",
    input: "---\ntext",
    expected: "text",
    truncated: false,
  },
  {
    name: "13 long prose backs off to the last space at or above the floor",
    input: PROSE,
    expected: `${`${WORD} `.repeat(14)}${WORD}…`,
    truncated: true,
  },
  {
    name: "14 a single unbroken token is cut at the budget",
    input: "x".repeat(200),
    expected: `${"x".repeat(120)}…`,
    truncated: true,
  },
  {
    name: "15 a space below the floor does not pull the cut back",
    input: `${"a".repeat(40)} ${"b".repeat(159)}`,
    expected: `${"a".repeat(40)} ${"b".repeat(79)}…`,
    truncated: true,
  },
  {
    name: "16 a space at or above the floor pulls the cut back to it",
    input: `${"a".repeat(100)} ${"b".repeat(99)}`,
    expected: `${"a".repeat(100)}…`,
    truncated: true,
  },
  {
    name: "17 an emoji straddling UTF-16 index 120 survives whole",
    input: `${"a".repeat(119)}😀${"b".repeat(80)}`,
    expected: `${"a".repeat(119)}😀…`,
    truncated: true,
  },
  {
    name: "18 an underscore between word characters is literal, not emphasis",
    input: "**bold** and snake_case stays",
    expected: "bold and snake_case stays",
    truncated: false,
  },
];

describe("markdownExcerpt", () => {
  it.each(cases)("$name", ({ input, expected, truncated }) => {
    expect(markdownExcerpt(input)).toEqual({ text: expected, truncated });
  });

  // The floor is 60% of the budget. A hardcoded 72 would reject this space at
  // index 30 and cut at the budget instead, producing a different string.
  it("derives the word-boundary floor from maxChars", () => {
    expect(markdownExcerpt(`${"a".repeat(30)} ${"b".repeat(30)}`, 40)).toEqual({
      text: `${"a".repeat(30)}…`,
      truncated: true,
    });
  });
});
