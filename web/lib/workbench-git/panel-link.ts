import type { RunKind } from "@/lib/db/schema";

// ADR-181 D16: the run git panel's sections, addressed by the run detail's URL
// state (`?git=<section>`). Cards, the rail and the inspector link here instead
// of mutating blind — a publish needs a name, an update an `onto`.
const GIT_PANEL_SECTIONS = [
  "tree",
  "publish",
  "update",
  "pr",
  "reattach",
] as const;

export type GitPanelSection = (typeof GIT_PANEL_SECTIONS)[number];

const SECTION_BY_ACTION: Record<string, GitPanelSection> = {
  snapshotCommit: "tree",
  discardChanges: "tree",
  exportBranch: "publish",
  handoffBranch: "publish",
  update: "update",
  openPr: "pr",
  finalizePr: "pr",
  reattach: "reattach",
};

export function isGitPanelSection(value: unknown): value is GitPanelSection {
  return (
    typeof value === "string" &&
    (GIT_PANEL_SECTIONS as readonly string[]).includes(value)
  );
}

export function gitPanelSectionFor(actionId: string): GitPanelSection | null {
  return SECTION_BY_ACTION[actionId] ?? null;
}

// Null for an action with no panel section (stop, archive, drop, promote,
// recover): those controls live on the page itself.
export function gitPanelHref(args: {
  runId: string;
  runKind: RunKind;
  actionId: string;
}): string | null {
  const section = gitPanelSectionFor(args.actionId);

  if (section === null) return null;

  const base =
    args.runKind === "scratch"
      ? `/scratch-runs/${args.runId}`
      : `/runs/${args.runId}`;

  return `${base}?git=${section}`;
}
