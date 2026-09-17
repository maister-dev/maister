const FENCE_LINE = /^\s*(?:```|~~~)/;
// A line of only rule/table punctuation: an HR (`---`, `***`, `___`) and a GFM
// alignment row (`|---|:--:|`) both carry no cell text, so both drop whole.
const RULE_OR_ALIGNMENT_LINE = /^[\s|:*_-]*[-*_][\s|:*_-]*$/;
const BLOCKQUOTE_MARKER = /^\s*(?:>\s?)+/;
const HEADING_MARKER = /^\s*#{1,6}\s+/;
const LIST_MARKER = /^\s*(?:[-*+]\s+|\d+[.)]\s+)/;
const IMAGE = /!\[([^\]]*)\]\([^)]*\)/g;
const LINK = /\[([^\]]*)\]\([^)]*\)/g;
// Only the angle-bracket form the renderer UNWRAPS. A CommonMark autolink
// becomes a link whose text has no brackets, so the excerpt drops them too.
// Raw HTML is deliberately absent here: `MarkdownBody` mounts remark-only with
// no rehype-raw (ADR-078 D10), so `<div>` and `Array<string>` render as literal
// text one click below — stripping them would make the excerpt disagree, the
// same way stripping an intra-word `_` would.
const AUTOLINK =
  /<([A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*|[^\s<>@]+@[^\s<>@]+)>/g;
const BACKTICKS = /`+/g;
const EMPHASIS_MARKER = /\*\*|~~|\*/g;
// CommonMark refuses an underscore run flanked by word characters, so
// `snake_case` is literal there. Stripping it here would make the excerpt read
// `snakecase` while the expanded Markdown right below reads `snake_case`.
const UNDERSCORE_EMPHASIS = /(?<![\p{L}\p{N}])_{1,2}|_{1,2}(?![\p{L}\p{N}])/gu;
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
    .replace(AUTOLINK, "$1")
    .replace(BACKTICKS, "")
    .replace(EMPHASIS_MARKER, "")
    .replace(UNDERSCORE_EMPHASIS, "")
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

  // No trailing trim: whitespace runs are already collapsed, and a space at the
  // last in-budget index would itself be `lastSpace` (>= floor), so the
  // hard-cut branch cannot end on one either.
  const cut = lastSpace >= floor ? lastSpace : maxChars;

  return { text: `${codePoints.slice(0, cut).join("")}…`, truncated: true };
}
