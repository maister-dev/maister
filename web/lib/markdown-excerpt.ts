const FENCE_LINE = /^\s*(?:```|~~~)/;
// A line of only rule/table punctuation: an HR (`---`, `***`, `___`) and a GFM
// alignment row (`|---|:--:|`) both carry no cell text, so both drop whole.
const RULE_OR_ALIGNMENT_LINE = /^[\s|:*_-]*[-*_][\s|:*_-]*$/;
const BLOCKQUOTE_MARKER = /^\s*(?:>\s?)+/;
const HEADING_MARKER = /^\s*#{1,6}\s+/;
const LIST_MARKER = /^\s*(?:[-*+]\s+|\d+[.)]\s+)/;
const IMAGE = /!\[([^\]]*)\]\([^)]*\)/g;
const LINK = /\[([^\]]*)\]\([^)]*\)/g;
const HTML_TAG = /<[^>]*>/g;
const BACKTICKS = /`+/g;
const EMPHASIS_MARKER = /\*\*|__|~~|[*_]/g;
const WHITESPACE_RUN = /\s+/g;

const WORD_BOUNDARY_FLOOR_RATIO = 0.6;

function toPlainText(source: string): string {
  return source
    .split("\n")
    .filter(
      (line) => !FENCE_LINE.test(line) && !RULE_OR_ALIGNMENT_LINE.test(line),
    )
    .map((line) =>
      line
        .replace(BLOCKQUOTE_MARKER, "")
        .replace(HEADING_MARKER, "")
        .replace(LIST_MARKER, "")
        .replace(/\|/g, " "),
    )
    .join(" ")
    .replace(IMAGE, "$1")
    .replace(LINK, "$1")
    .replace(HTML_TAG, "")
    .replace(BACKTICKS, "")
    .replace(EMPHASIS_MARKER, "")
    .replace(WHITESPACE_RUN, " ")
    .trim();
}

export function markdownExcerpt(
  source: string,
  maxChars = 120,
): { text: string; truncated: boolean } {
  const plain = toPlainText(source);
  // Code points, not UTF-16 units: slicing mid-surrogate emits a lone half.
  const codePoints = Array.from(plain);

  if (codePoints.length <= maxChars) return { text: plain, truncated: false };

  const floor = Math.ceil(maxChars * WORD_BOUNDARY_FLOOR_RATIO);
  let lastSpace = -1;

  for (let index = 0; index < maxChars; index += 1) {
    if (codePoints[index] === " ") lastSpace = index;
  }

  const cut = lastSpace >= floor ? lastSpace : maxChars;

  return {
    text: `${codePoints.slice(0, cut).join("").trimEnd()}…`,
    truncated: true,
  };
}
