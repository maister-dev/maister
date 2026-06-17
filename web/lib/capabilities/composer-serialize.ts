import type { CapabilityKind } from "@/lib/capabilities/token-normalizer";

// Pure, client-safe (used by the TipTap composer AND unit tests in the node
// lane). Converts between the canonical-token STORAGE string (`@skill:<slug>` /
// `@agent:<slug>`, FR-E1) and an ordered list of composer segments (plain text
// runs + capability chips). The TipTap component maps segments ↔ ProseMirror doc.

export type ComposerSegment =
  | { type: "text"; text: string }
  | { type: "chip"; kind: CapabilityKind; slug: string };

const CANONICAL_TOKEN_RE =
  /@(skill|agent):([a-z0-9](?:[a-z0-9._-]*[a-z0-9])?)/g;

function canonicalPrefix(kind: CapabilityKind): "skill" | "agent" {
  return kind === "skill" ? "skill" : "agent";
}

/** Storage form for a single chip (`@skill:<slug>` / `@agent:<slug>`). */
export function chipToCanonical(kind: CapabilityKind, slug: string): string {
  return `@${canonicalPrefix(kind)}:${slug}`;
}

/** Segments → the canonical-token string stored in flow.yaml / scratch drafts. */
export function segmentsToCanonical(segments: ComposerSegment[]): string {
  return segments
    .map((seg) =>
      seg.type === "text" ? seg.text : chipToCanonical(seg.kind, seg.slug),
    )
    .join("");
}

/**
 * Split a flat segment list into paragraph groups at `\n` inside text segments.
 * The TipTap doc is paragraph-per-line (Enter inserts a new `paragraph` node,
 * not a `\n` character), so a multiline prompt MUST map to one group per line or
 * the paragraph boundaries are lost on serialize. Chips stay inline in the
 * current group. Always returns at least one (possibly empty) group.
 */
export function segmentsToParagraphs(
  segments: ComposerSegment[],
): ComposerSegment[][] {
  const paragraphs: ComposerSegment[][] = [[]];

  for (const seg of segments) {
    if (seg.type !== "text") {
      paragraphs[paragraphs.length - 1].push(seg);
      continue;
    }

    const lines = seg.text.split("\n");

    lines.forEach((line, index) => {
      if (index > 0) paragraphs.push([]);
      if (line)
        paragraphs[paragraphs.length - 1].push({ type: "text", text: line });
    });
  }

  return paragraphs;
}

/** Join paragraph groups back to the canonical string (paragraph boundary → `\n`). */
export function paragraphsToCanonical(paragraphs: ComposerSegment[][]): string {
  return paragraphs.map(segmentsToCanonical).join("\n");
}

/**
 * Canonical-token string → segments. Canonical `@skill:`/`@agent:` tokens become
 * chips; everything else is verbatim text (raw `/x`/`$x` promotion is the
 * matcher's job, FR-E3 — not done here). Adjacent text is coalesced.
 */
export function canonicalToSegments(value: string): ComposerSegment[] {
  const segments: ComposerSegment[] = [];
  let lastIndex = 0;

  const pushText = (text: string) => {
    if (!text) return;
    const prev = segments[segments.length - 1];

    if (prev && prev.type === "text") {
      prev.text += text;
    } else {
      segments.push({ type: "text", text });
    }
  };

  for (const match of value.matchAll(CANONICAL_TOKEN_RE)) {
    const index = match.index ?? 0;

    pushText(value.slice(lastIndex, index));
    segments.push({
      type: "chip",
      kind: match[1] === "skill" ? "skill" : "subagent",
      slug: match[2],
    });
    lastIndex = index + match[0].length;
  }

  pushText(value.slice(lastIndex));

  return segments;
}
