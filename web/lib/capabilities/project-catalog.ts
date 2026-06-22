import type { AdapterId } from "@/lib/acp-runners/adapter-support";

import { surfaceFormForSkill } from "@/lib/capabilities/token-normalizer";

// Pure, client-safe entry-building for the unified composer's autocomplete
// catalog (FR-B2/B3). The browser re-runs these on a runner switch to recompute
// surface forms without refetching (FR-D10/E2). DB loading lives in catalog.ts.

export type ProjectCapabilityKind = "skill" | "subagent" | "command";

export type ProjectCapabilityCatalogEntry = {
  kind: ProjectCapabilityKind;
  refId: string;
  slug: string;
  displayName: string;
  description: string | null;
  argHint: string | null;
  canonicalToken: string;
  surfaceForm: string;
  supported: boolean;
};

export type CapabilityAgentsMask =
  | readonly string[]
  | Record<string, string | null>;

/** Mirrors resolver.ts `supportsAgent`: array → membership; map → key present. */
export function capabilityAgentSupported(
  agents: CapabilityAgentsMask | null | undefined,
  agent: AdapterId,
): boolean {
  if (!agents) return true;
  if (Array.isArray(agents)) return agents.includes(agent);

  return (agents as Record<string, unknown>)[agent] !== undefined;
}

export type SkillCatalogInput = {
  refId: string;
  label: string;
  agents: CapabilityAgentsMask;
  material: Record<string, unknown> | null | undefined;
};

export function skillCatalogEntry(
  skill: SkillCatalogInput,
  agent: AdapterId,
): ProjectCapabilityCatalogEntry {
  const slug = skill.refId;
  const material = skill.material ?? {};
  const description =
    typeof material.description === "string" ? material.description : null;
  const argHint =
    typeof material.argHint === "string" ? material.argHint : null;

  return {
    kind: "skill",
    refId: skill.refId,
    slug,
    displayName: skill.label,
    description,
    argHint,
    canonicalToken: `@skill:${slug}`,
    surfaceForm: surfaceFormForSkill(slug, agent),
    supported: capabilityAgentSupported(skill.agents, agent),
  };
}

export type SubagentCatalogInput = {
  refId: string;
  slug: string;
  displayName: string;
  description: string | null;
};

export function subagentCatalogEntry(
  sub: SubagentCatalogInput,
): ProjectCapabilityCatalogEntry {
  return {
    kind: "subagent",
    refId: sub.refId,
    slug: sub.slug,
    displayName: sub.displayName,
    description: sub.description,
    argHint: null,
    canonicalToken: `@agent:${sub.slug}`,
    surfaceForm: `@${sub.slug}`,
    // Only ever built for claude (FR-B3): subagents are claude-only.
    supported: true,
  };
}
