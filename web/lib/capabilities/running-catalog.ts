import type { AdapterId } from "@/lib/acp-runners/adapter-support";
import type { ProjectCapabilityCatalogEntry } from "@/lib/capabilities/project-catalog";

import {
  SLUG_PATTERN,
  surfaceFormForSkill,
} from "@/lib/capabilities/token-normalizer";

// Pure, client-safe (same rationale as project-catalog.ts): the running-scratch
// composer (browser) merges the live ACP command snapshot with the static
// catalog here. No server-only deps — the shape mirrors AvailableCommandDto.

export type RunningLiveCommand = {
  name: string;
  description?: string | null;
  hint?: string | null;
};

/**
 * Build the running-scratch composer catalog from the live `availableCommands`
 * snapshot (FR-A3 / lifecycle source #3): the live list is authoritative for
 * what the running session actually exposes; the static catalog enriches it with
 * display names + descriptions and supplies the claude-only coder subagents that
 * never appear in the stream.
 *
 * Live command names arrive AS-EMITTED (codex bakes `$`, claude emits bare or a
 * `mcp:` prefix). Each `/`·`$` command maps to a skill chip: the sigil is
 * stripped to the canonical slug, `surfaceForm` is recomputed table-driven for
 * the (fixed) running runner, and the chip serializes to `@skill:<slug>` so the
 * existing send-time normalizer round-trips it back to the runner's wire form.
 * `mcp:` commands are MCP built-ins, not capability chips, and are skipped. A
 * live command is supported by definition — it is present in the live session.
 */
export function buildRunningCommandCatalog(
  live: RunningLiveCommand[],
  staticCatalog: ProjectCapabilityCatalogEntry[],
  agent: AdapterId,
): ProjectCapabilityCatalogEntry[] {
  const staticSkillBySlug = new Map(
    staticCatalog
      .filter((entry) => entry.kind === "skill")
      .map((entry) => [entry.slug, entry] as const),
  );
  const skills: ProjectCapabilityCatalogEntry[] = [];
  const seen = new Set<string>();

  for (const cmd of live) {
    if (cmd.name.startsWith("mcp:")) continue;

    const slug = cmd.name.replace(/^[/$]/, "");

    if (!SLUG_PATTERN.test(slug) || seen.has(slug)) continue;
    seen.add(slug);

    const fromStatic = staticSkillBySlug.get(slug);

    skills.push({
      kind: "skill",
      refId: fromStatic?.refId ?? slug,
      slug,
      displayName: fromStatic?.displayName ?? slug,
      description: cmd.description ?? fromStatic?.description ?? null,
      argHint: cmd.hint ?? fromStatic?.argHint ?? null,
      canonicalToken: `@skill:${slug}`,
      surfaceForm: surfaceFormForSkill(slug, agent),
      supported: true,
    });
  }

  const subagents = staticCatalog.filter((entry) => entry.kind === "subagent");

  return [...skills, ...subagents];
}
