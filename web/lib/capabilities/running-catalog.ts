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
 * `mcp:` prefix). Each `/`·`$` command that matches a PROJECT SKILL (present in
 * the static catalog) maps to a skill chip: the sigil is stripped to the
 * canonical slug, `surfaceForm` is recomputed table-driven for the (fixed)
 * running runner, and the chip serializes to `@skill:<slug>` so the existing
 * send-time normalizer round-trips it back to the runner's wire form.
 *
 * `mcp:` commands are MCP built-ins, and a live command with NO static match is
 * a native/built-in command (claude `/compact`, codex `/status`) — neither is a
 * capability chip (D8: native = typed raw). Chipifying a built-in would re-derive
 * its wire form via the skill sigil and CORRUPT it on codex (`/status` → the
 * skill form `$status`); excluding it keeps it typeable as literal text the agent
 * resolves natively. A chipped live command is supported by definition — it is a
 * known project skill present in the live session.
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

    // A live command with no static match is a native/built-in (not a project
    // skill) → not a chip: it stays typeable as raw text. This is also the
    // codex correctness guard — re-sigiling a built-in `/status` would emit the
    // wrong `$status` skill form (see the function doc).
    const fromStatic = staticSkillBySlug.get(slug);

    if (!fromStatic) continue;
    seen.add(slug);

    skills.push({
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
  }

  const subagents = staticCatalog.filter((entry) => entry.kind === "subagent");

  return [...skills, ...subagents];
}
