// ADR-151 — pure helpers behind the comment composer's `@` popover. Kept out
// of the component so the interaction layer holds no matching logic.
//
// The token rule MIRRORS the server scanner (lib/social/mentions.ts): `@` at a
// word boundary, handle charset `[A-Za-z0-9._-]` with one optional `:`. If the
// two ever disagree, the popover offers a completion the write path refuses to
// resolve.

export type MentionCandidateView = {
  id: string;
  name: string;
};

const MAX_ROWS = 8;
const HANDLE_CHAR = /[A-Za-z0-9._:-]/;
const BOUNDARY_CHAR = /[\s(]/;

/**
 * The mention token under `caret`, or null when the caret is not inside one.
 * `start` is the index of the `@` so a selection can splice it out.
 */
export function detectMentionQuery(
  text: string,
  caret: number,
): { start: number; query: string } | null {
  let index = caret - 1;

  while (index >= 0 && HANDLE_CHAR.test(text[index])) index -= 1;

  if (index < 0 || text[index] !== "@") return null;
  if (index > 0 && !BOUNDARY_CHAR.test(text[index - 1])) return null;

  return { start: index, query: text.slice(index + 1, caret) };
}

/** Prefix matches first (id, stem, or name), then substring; capped at 8. */
export function filterMentionCandidates(
  candidates: MentionCandidateView[],
  query: string,
): MentionCandidateView[] {
  const needle = query.toLowerCase();

  if (needle === "") return candidates.slice(0, MAX_ROWS);

  const scored: Array<{ candidate: MentionCandidateView; rank: number }> = [];

  for (const candidate of candidates) {
    const id = candidate.id.toLowerCase();
    const stem = id.slice(id.indexOf(":") + 1);
    const name = candidate.name.toLowerCase();
    const prefix =
      id.startsWith(needle) ||
      stem.startsWith(needle) ||
      name.startsWith(needle);
    const substring = id.includes(needle) || name.includes(needle);

    if (prefix) scored.push({ candidate, rank: 0 });
    else if (substring) scored.push({ candidate, rank: 1 });
  }

  return scored
    .sort((left, right) => left.rank - right.rank)
    .slice(0, MAX_ROWS)
    .map((entry) => entry.candidate);
}

/** Splices the canonical id over the partial token and adds one trailing space. */
export function applyMentionSelection(
  text: string,
  caret: number,
  start: number,
  agentId: string,
): { text: string; caret: number } {
  const inserted = `@${agentId} `;

  return {
    text: `${text.slice(0, start)}${inserted}${text.slice(caret)}`,
    caret: start + inserted.length,
  };
}
