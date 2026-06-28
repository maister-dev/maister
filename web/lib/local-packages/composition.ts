import type { AuthoredFlowPackageFile } from "@/lib/catalog/authored-types";
import type { PackageBom } from "@/lib/queries/package-bom";

// Pure, client-safe helpers for the tabbed composition view (ADR-115). NO
// `server-only`, NO `node:*` — imported by the `"use client"` PackageComposition
// and unit-tested directly. Routing + tab-resolution logic lives here so the
// component stays a thin renderer.

// The six BOM-backed kinds + the always-present Files tab, in display order.
export const COMPOSITION_KINDS = [
  "flows",
  "skills",
  "subagents",
  "agents",
  "mcps",
  "rules",
] as const;

export type CompositionKind = (typeof COMPOSITION_KINDS)[number];

export const COMPOSITION_TAB_IDS = [...COMPOSITION_KINDS, "files"] as const;

export type CompositionTabId = (typeof COMPOSITION_TAB_IDS)[number];

// The kinds whose cards open INLINE (master-detail), as opposed to routing away
// (flows → canvas, skills → dedicated screen).
const INLINE_KINDS = new Set<CompositionKind>([
  "subagents",
  "agents",
  "mcps",
  "rules",
]);

export function isInlineKind(kind: string): kind is CompositionKind {
  return INLINE_KINDS.has(kind as CompositionKind);
}

function isCompositionTabId(value: string): value is CompositionTabId {
  return (COMPOSITION_TAB_IDS as readonly string[]).includes(value);
}

// Per-kind member counts (tab counts equal BOM array lengths — invariant).
export function compositionCounts(
  bom: PackageBom,
): Record<CompositionKind, number> {
  return {
    flows: bom.flows.length,
    skills: bom.skills.length,
    subagents: bom.subagents.length,
    agents: bom.platformAgents.length,
    mcps: bom.mcps.length,
    rules: bom.rules.length,
  };
}

// Tabs to render: a kind tab is shown iff its count > 0; Files is ALWAYS shown
// (the disk-level escape hatch). Order follows COMPOSITION_TAB_IDS.
export function visibleCompositionTabs(bom: PackageBom): CompositionTabId[] {
  const counts = compositionCounts(bom);

  return COMPOSITION_TAB_IDS.filter(
    (id) => id === "files" || counts[id as CompositionKind] > 0,
  );
}

// Resolve the active tab: the requested one if visible, else the first visible
// kind, else Files (always visible).
export function resolveCompositionTab(
  requested: string | null | undefined,
  bom: PackageBom,
): CompositionTabId {
  const visible = visibleCompositionTabs(bom);

  if (
    requested &&
    isCompositionTabId(requested) &&
    visible.includes(requested)
  ) {
    return requested;
  }

  return visible.find((id) => id !== "files") ?? "files";
}

function encodePathSegments(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

// A flow opens on the canvas: the route must carry a flow-manifest path the page
// recognizes (`flows/<…>/flow.yaml` or a `*.yaml` under `flows/`). A BOM flow's
// `path` is the flow DIRECTORY (`flows/<id>`), so append `flow.yaml`; a path that
// is already a yaml file is used verbatim.
export function flowCanvasHref(packageId: string, flowPath: string): string {
  const manifestPath = /\.ya?ml$/i.test(flowPath)
    ? flowPath
    : `${flowPath.replace(/\/+$/, "")}/flow.yaml`;

  return `/studio/edit/${packageId}/${encodePathSegments(manifestPath)}`;
}

// A skill opens its own dedicated screen (nested navigator, Phase 4).
export function skillScreenHref(packageId: string, skillId: string): string {
  return `/studio/edit/${packageId}/skills/${encodePathSegments(skillId)}`;
}

// The composition landing (no path segments). Tab + inline selection live in the
// query so back/forward + refresh + deep-link work (the data-management rule).
export function compositionTabHref(
  packageId: string,
  tab: CompositionTabId,
): string {
  return `/studio/edit/${packageId}?tab=${tab}`;
}

export function inlineSelectHref(
  packageId: string,
  tab: CompositionKind,
  id: string,
): string {
  return `/studio/edit/${packageId}?tab=${tab}&sel=${encodeURIComponent(id)}`;
}

// (ADR-115 §D6) MCP descriptors in a local working dir are authored as files
// `mcps/<name>.yaml` (the McpTemplateEditor), NOT manifest-inline entries like an
// installed package. `classifyPackageFilePath` returns "asset" for `mcps/`, so the
// composition view + local BOM + editor-routing special-case the path here rather
// than broadening the shared classifier (which feeds the installed reader).
// Matches a DIRECT child of `mcps/` with a `.yaml`/`.yml` extension only.
export function isMcpDescriptorPath(relPath: string): boolean {
  return /^mcps\/[^/]+\.ya?ml$/.test(relPath);
}

export function mcpStem(relPath: string): string {
  const base = relPath.split("/").pop() ?? relPath;

  return base.replace(/\.ya?ml$/, "");
}

// The capability bundles present in the draft (`capability/<cap>/…`), for the
// subagent create picker — a new subagent must land in a capability (ADR-115 P5).
export function listCapabilities(
  files: ReadonlyArray<AuthoredFlowPackageFile>,
): string[] {
  const caps = new Set<string>();

  for (const file of files) {
    const match = /^capability\/([^/]+)\//.exec(file.path);

    if (match) caps.add(match[1]);
  }

  return [...caps].sort();
}

// The working-dir prefix of a skill's nested subtree (skills have folders, so the
// dedicated skill screen scopes the file navigator to this prefix — ADR-115 P4).
export function skillSubtreePrefix(skillId: string): string {
  return `skills/${skillId}/`;
}

// The draft files under a skill's subtree (its dedicated screen edits only these).
export function scopeSkillFiles(
  files: ReadonlyArray<AuthoredFlowPackageFile>,
  skillId: string,
): AuthoredFlowPackageFile[] {
  const prefix = skillSubtreePrefix(skillId);

  return files.filter((file) => file.path.startsWith(prefix));
}

// Merge the skill screen's edited subtree back into the full draft: replace the
// skill's files, preserve everything else. The edited set carries full paths, so
// a file renamed within the subtree stays under the prefix.
export function mergeSkillFiles(
  files: ReadonlyArray<AuthoredFlowPackageFile>,
  skillId: string,
  scopedNext: ReadonlyArray<AuthoredFlowPackageFile>,
): AuthoredFlowPackageFile[] {
  const prefix = skillSubtreePrefix(skillId);

  return [
    ...files.filter((file) => !file.path.startsWith(prefix)),
    ...scopedNext,
  ];
}

// Resolve the working-dir file path backing an inline-kind element. Single-file
// kinds carry their path on the BOM card; an MCP's id maps to its `mcps/*.yaml`
// file (found in the draft, or the canonical `mcps/<id>.yaml`).
export function resolveInlineFilePath(
  kind: CompositionKind,
  id: string,
  bom: PackageBom,
  draftFiles: ReadonlyArray<AuthoredFlowPackageFile>,
): string | null {
  switch (kind) {
    case "subagents":
      return bom.subagents.find((s) => s.id === id)?.path ?? null;
    case "agents":
      return bom.platformAgents.find((a) => a.id === id)?.path ?? null;
    case "rules":
      return bom.rules.find((r) => r.id === id)?.path ?? null;
    case "mcps": {
      const file = draftFiles.find(
        (f) => isMcpDescriptorPath(f.path) && mcpStem(f.path) === id,
      );

      return file?.path ?? `mcps/${id}.yaml`;
    }
    default:
      return null;
  }
}
