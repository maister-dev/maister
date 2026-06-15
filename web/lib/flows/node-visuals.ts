import type { GateKind, NodeType } from "@/lib/flows/editor/editor-state";

// Pure node/gate visual map (SDD spec §3.2). `iconName` keys the SVG registry in
// the renderer; `colorToken` is a forest-palette CSS-var base — the chip paints
// the icon with `var(--<colorToken>)`. The design SSOT names hues as roles
// (teal/violet/slate/…); the live palette is muted forest green + `attention`
// (warm amber) + `danger`, so roles collapse onto existing tokens (icon shape is
// the primary type signal). Canonical table:
// docs/system-analytics/flow-studio.md §"Node visual language".
export type NodeVisual = { iconName: string; colorToken: string };

// Record (not a function body) so a new NodeType/GateKind is a COMPILE error
// until its visual is declared — exhaustiveness without a runtime switch.
const NODE_VISUALS: Record<NodeType, NodeVisual> = {
  ai_coding: { iconName: "bot", colorToken: "accent-3" },
  judge: { iconName: "gavel", colorToken: "accent-2" },
  cli: { iconName: "terminal", colorToken: "mute" },
  check: { iconName: "shield", colorToken: "attention" },
  human: { iconName: "person", colorToken: "amber" },
};

const GATE_VISUALS: Record<GateKind, NodeVisual> = {
  command_check: { iconName: "terminal", colorToken: "mute" },
  skill_check: { iconName: "puzzle", colorToken: "good" },
  ai_judgment: { iconName: "gavel", colorToken: "accent-2" },
  artifact_required: { iconName: "file", colorToken: "accent-3" },
  external_check: { iconName: "link", colorToken: "accent-4" },
  human_review: { iconName: "person", colorToken: "amber" },
};

// Unknown/absent type (e.g. a fresh canvas node with role "other") → neutral dot,
// never a throw.
const DEFAULT_VISUAL: NodeVisual = { iconName: "dot", colorToken: "mute" };

export function nodeVisual(type: string): NodeVisual {
  return NODE_VISUALS[type as NodeType] ?? DEFAULT_VISUAL;
}

export function gateVisual(kind: string): NodeVisual {
  return GATE_VISUALS[kind as GateKind] ?? DEFAULT_VISUAL;
}
