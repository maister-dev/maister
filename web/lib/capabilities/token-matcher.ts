import type { CapabilityKind } from "@/lib/capabilities/token-normalizer";

// Pure, dependency-free, client-safe (same rationale as token-normalizer.ts).

export type MatchCatalogEntry = {
  kind: CapabilityKind;
  slug: string;
};

export type PromotedToken = {
  raw: string;
  canonical: string;
  kind: CapabilityKind;
  slug: string;
  index: number;
};

export type MatchResult = {
  text: string;
  promoted: PromotedToken[];
};

// sigil + slug, boundary-anchored: lookbehind = start/whitespace/"(", lookahead
// = end/whitespace/sentence-punctuation. "/" is NOT a trailing boundary, so
// `/usr/bin` is rejected. The slug must start AND end alphanumeric so a trailing
// "." is a boundary (sentence end), not absorbed into the slug.
const CANDIDATE_RE =
  /(?<=^|[\s(])([/$@])([a-z0-9](?:[a-z0-9._-]*[a-z0-9])?)(?=$|[\s).,;:!?'"\]}])/g;

/** [start, end) ranges covered by fenced code blocks or inline code spans. */
function codeMaskRanges(content: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const fence = /```[\s\S]*?```|~~~[\s\S]*?~~~/g;
  let m: RegExpExecArray | null;

  while ((m = fence.exec(content)) !== null) {
    ranges.push([m.index, m.index + m[0].length]);
  }

  const insideFence = (i: number) => ranges.some(([s, e]) => i >= s && i < e);
  const span = /`[^`\n]*`/g;

  while ((m = span.exec(content)) !== null) {
    if (!insideFence(m.index)) {
      ranges.push([m.index, m.index + m[0].length]);
    }
  }

  return ranges;
}

/**
 * Promote raw `/x` · `$x` · `@x` that EXACTLY match a catalog entry to a
 * canonical ref (`@skill:x` / `@agent:x`). Boundary-anchored, code-span
 * suppressed, sigil-agnostic for skills (`/x` and `$x` → same ref). Non-matches
 * are never deleted or mangled (FR-E3). `@` binds to the subagent kind only;
 * `/`·`$` bind to skills.
 */
export function matchCapabilityTokens(
  content: string,
  catalog: MatchCatalogEntry[],
): MatchResult {
  const skills = new Set(
    catalog.filter((e) => e.kind === "skill").map((e) => e.slug),
  );
  const subagents = new Set(
    catalog.filter((e) => e.kind === "subagent").map((e) => e.slug),
  );
  const masked = codeMaskRanges(content);
  const isMasked = (i: number) => masked.some(([s, e]) => i >= s && i < e);

  const promoted: PromotedToken[] = [];

  const text = content.replace(
    CANDIDATE_RE,
    (raw: string, sigil: string, slug: string, offset: number) => {
      if (isMasked(offset)) {
        return raw;
      }

      let kind: CapabilityKind | null = null;

      if ((sigil === "/" || sigil === "$") && skills.has(slug)) {
        kind = "skill";
      } else if (sigil === "@" && subagents.has(slug)) {
        kind = "subagent";
      }

      if (kind === null) {
        return raw;
      }

      // Canonical grammar uses `@agent:` for subagents (not `@subagent:`), so
      // the normalizer's CANONICAL_TOKEN_RE recognizes the promoted token.
      const prefix = kind === "skill" ? "skill" : "agent";
      const canonical = `@${prefix}:${slug}`;

      promoted.push({ raw, canonical, kind, slug, index: offset });

      return canonical;
    },
  );

  return { text, promoted };
}
