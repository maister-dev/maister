import type { GateKind, NodeType } from "@/lib/flows/editor/editor-state";

// Pure node/gate visual map (SDD spec §3.2). `iconName` keys the SVG glyph
// registry in the renderer; `colorToken` is a brand-neutral canvas-palette CSS-var
// base (`--cv-*`, defined in globals.css for light + dark). The renderer paints the
// icon with `var(--<colorToken>)`, the chip background with
// `var(--<colorToken>-soft)`, and tints the card border with the same hue. Each
// node type and gate kind gets a distinct hue (green/violet/gray/amber/blue +
// teal/rose) so the graph reads at a glance. Canonical table:
// docs/system-analytics/flow-studio.md §"Node visual language".
export type NodeVisual = { iconName: string; colorToken: string };

// Record (not a function body) so a new NodeType/GateKind is a COMPILE error
// until its visual is declared — exhaustiveness without a runtime switch.
const NODE_VISUALS: Record<NodeType, NodeVisual> = {
  ai_coding: { iconName: "bot", colorToken: "cv-green" },
  orchestrator: { iconName: "sitemap", colorToken: "cv-teal" },
  judge: { iconName: "gavel", colorToken: "cv-violet" },
  consensus: { iconName: "network", colorToken: "cv-teal" },
  cli: { iconName: "terminal", colorToken: "cv-gray" },
  check: { iconName: "shield", colorToken: "cv-amber" },
  human: { iconName: "person", colorToken: "cv-blue" },
  form: { iconName: "form", colorToken: "cv-rose" },
};

const GATE_VISUALS: Record<GateKind, NodeVisual> = {
  command_check: { iconName: "terminal", colorToken: "cv-gray" },
  skill_check: { iconName: "puzzle", colorToken: "cv-teal" },
  ai_judgment: { iconName: "gavel", colorToken: "cv-violet" },
  artifact_required: { iconName: "file", colorToken: "cv-amber" },
  external_check: { iconName: "link", colorToken: "cv-blue" },
  human_review: { iconName: "person", colorToken: "cv-rose" },
};

// Unknown/absent type (e.g. a fresh canvas node with role "other") → neutral gray
// dot, never a throw.
const DEFAULT_VISUAL: NodeVisual = { iconName: "dot", colorToken: "cv-gray" };

export function nodeVisual(type: string): NodeVisual {
  return NODE_VISUALS[type as NodeType] ?? DEFAULT_VISUAL;
}

export function gateVisual(kind: string): NodeVisual {
  return GATE_VISUALS[kind as GateKind] ?? DEFAULT_VISUAL;
}
