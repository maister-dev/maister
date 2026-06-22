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

function slugForSkillMatch(name: string): string {
  return name.replace(/^[/$]/, "");
}

function surfaceFormForCommand(name: string, agent: AdapterId): string {
  if (name.startsWith("/") || name.startsWith("$") || name.includes(":")) {
    return name;
  }

  return surfaceFormForSkill(name, agent);
}

/**
 * Build the running-scratch composer catalog from the live `availableCommands`
 * snapshot (FR-A3 / lifecycle source #3): the live list is authoritative for
 * what the running session actually exposes; the static catalog enriches it with
 * display names + descriptions and supplies the claude-only coder subagents that
 * never appear in the stream.
 *
 * Live command names arrive AS-EMITTED (codex bakes `$`, claude emits bare or a
 * `mcp:` prefix). Each `/`·`$` command that matches a PROJECT SKILL (present in
 * the static catalog) maps to a skill chip: the sigil is stripped to the
 * canonical slug, `surfaceForm` is recomputed table-driven for the (fixed)
 * running runner, and the chip serializes to `@skill:<slug>` so the existing
 * send-time normalizer round-trips it back to the runner's wire form.
 *
 * A live command with NO static match is a native/built-in command (claude
 * `/compact`, codex `/status`, MCP command handles, etc.). Those are still shown
 * in autocomplete, but as raw `command` entries: picking one inserts the exact
 * command text instead of a canonical `@skill:` token. That preserves adapter
 * wire forms like codex `/status` instead of corrupting them to `$status`.
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
  const liveEntries: ProjectCapabilityCatalogEntry[] = [];
  const seen = new Set<string>();

  for (const cmd of live) {
    const name = cmd.name.trim();

    if (!name) continue;

    const slug = slugForSkillMatch(name);

    if (seen.has(slug)) continue;
    const fromStatic = staticSkillBySlug.get(slug);

    seen.add(slug);

    if (fromStatic && SLUG_PATTERN.test(slug)) {
      liveEntries.push({
        kind: "skill",
        refId: fromStatic.refId,
        slug,
        displayName: fromStatic.displayName,
        description: cmd.description ?? fromStatic.description ?? null,
        argHint: cmd.hint ?? fromStatic.argHint ?? null,
        canonicalToken: `@skill:${slug}`,
        surfaceForm: surfaceFormForSkill(slug, agent),
        supported: true,
      });

      continue;
    }

    const surfaceForm = surfaceFormForCommand(name, agent);

    liveEntries.push({
      kind: "command",
      refId: `command:${name}`,
      slug,
      displayName: surfaceForm,
      description: cmd.description ?? null,
      argHint: cmd.hint ?? null,
      canonicalToken: surfaceForm,
      surfaceForm,
      supported: true,
    });
  }

  const subagents = staticCatalog.filter((entry) => entry.kind === "subagent");

  return [...liveEntries, ...subagents];
}
