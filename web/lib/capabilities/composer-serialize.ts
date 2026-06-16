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
