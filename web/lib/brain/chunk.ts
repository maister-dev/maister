import "server-only";

// Project Brain (ADR-122, Sub-project A) oversize guard. Owned-tier items are
// short and embed directly; the RARE oversize item (content past the embedding
// model's practical input budget) is split into ordered segments by a minimal
// recursive character splitter — paragraphs → lines → sentences → hard slices.
//
// This deliberately avoids the `@chonkiejs/core` dependency the plan sketched
// for A: the typed ChunkerRegistry (chonkie/code-chunk/mdast) is Sub-project B,
// and pulling a chunking library in for a rare safety valve is premature. A
// single seam (`splitForEmbedding`) keeps the swap trivial when B lands.

// ~2k tokens for a byte-pair tokenizer; comfortably under text-embedding-3-small's
// 8191-token cap even for dense text.
const DEFAULT_MAX_CHARS = 8000;

const SEPARATORS = ["\n\n", "\n", ". ", " "] as const;

function recursiveSplit(
  text: string,
  maxChars: number,
  sepIdx: number,
): string[] {
  if (text.length <= maxChars) return [text];

  if (sepIdx >= SEPARATORS.length) {
    // No separator left — hard-slice on the character budget.
    const out: string[] = [];

    for (let i = 0; i < text.length; i += maxChars) {
      out.push(text.slice(i, i + maxChars));
    }

    return out;
  }

  const sep = SEPARATORS[sepIdx];
  const parts = text.split(sep);
  const segments: string[] = [];
  let buf = "";

  const flush = (): void => {
    if (buf.length > 0) segments.push(buf);
    buf = "";
  };

  for (const part of parts) {
    const candidate = buf.length > 0 ? `${buf}${sep}${part}` : part;

    if (candidate.length <= maxChars) {
      buf = candidate;
      continue;
    }

    flush();

    if (part.length <= maxChars) {
      buf = part;
    } else {
      // A single part still too big — recurse to the next finer separator.
      segments.push(...recursiveSplit(part, maxChars, sepIdx + 1));
    }
  }

  flush();

  return segments.filter((s) => s.length > 0);
}

// Split `content` into ordered segments each within `maxChars`. Short content
// (the common case) returns a single segment.
export function splitForEmbedding(
  content: string,
  maxChars: number = DEFAULT_MAX_CHARS,
): string[] {
  const text = content.trim();

  if (text.length === 0) return [];
  if (text.length <= maxChars) return [text];

  return recursiveSplit(text, maxChars, 0);
}
