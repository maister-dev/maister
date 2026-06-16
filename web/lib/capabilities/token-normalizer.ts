import {
  type AdapterId,
  capabilitySurfaceFor,
} from "@/lib/acp-runners/adapter-support";

// Pure, dependency-free, client-safe: the composer (browser) and the send-path
// (server) both import this. No logging/node deps here — callers log the
// returned warnings/decisions.

export type CapabilityKind = "skill" | "subagent";

/** Canonical slug grammar: starts + ends alphanumeric; internal `. _ -` allowed. */
export const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;

export type NormalizeWarning = {
  kind: CapabilityKind;
  slug: string;
  agent: AdapterId;
  reason: string;
};

export type NormalizeResult = {
  text: string;
  warnings: NormalizeWarning[];
};

// @skill:<slug> / @agent:<slug> — the canonical storage grammar (FR-E1).
const CANONICAL_TOKEN_RE =
  /@(skill|agent):([a-z0-9](?:[a-z0-9._-]*[a-z0-9])?)/g;

/** Wire form for a skill on the given adapter — table-driven (FR-E2). */
export function surfaceFormForSkill(slug: string, agent: AdapterId): string {
  return `${capabilitySurfaceFor(agent).skillSigil}${slug}`;
}

/**
 * Expand canonical capability tokens (`@skill:<slug>` / `@agent:<slug>`) to the
 * adapter's wire form. Web-side only; raw non-token text is left verbatim
 * (verbatim-forward invariant). A capability the runner cannot honor — a
 * subagent on a non-claude runner — degrades to its bare display name and is
 * reported as a warning, never a hard fail and never a silent rewrite (FR-E5).
 */
export function normalizeCapabilityTokens(
  content: string,
  agent: AdapterId,
): NormalizeResult {
  const surface = capabilitySurfaceFor(agent);
  const warnings: NormalizeWarning[] = [];

  const text = content.replace(
    CANONICAL_TOKEN_RE,
    (_raw, kindRaw: string, slug: string) => {
      if (kindRaw === "skill") {
        return `${surface.skillSigil}${slug}`;
      }

      if (surface.subagents) {
        return `@${slug}`;
      }

      warnings.push({
        kind: "subagent",
        slug,
        agent,
        reason: `subagent "${slug}" is not available on ${agent} (claude-only)`,
      });

      return slug;
    },
  );

  return { text, warnings };
}
