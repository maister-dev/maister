// M27/T-A2 (RED): render tests for the PRESENTATIONAL editor chrome of the flow
// graph editor. Uses renderToStaticMarkup (no jsdom), mirroring
// components/board/__tests__/flow-graph-view.test.ts.
//
// We render ONLY `FlowEditorToolbar` — the named, provider-free export with NO
// `<ReactFlow>`/`<Handle>` context. The full `FlowGraphEditor` default export
// wraps `<ReactFlow>` and is NOT renderable via renderToStaticMarkup; its drag /
// connect / live-preview behavior is the e2e's job (T-A9).
//
// Contract (module not built yet — RED on the missing import):
//   web/components/flows/flow-graph-editor.tsx exports
//     default FlowGraphEditor       (client component, NOT rendered here)
//     FlowEditorToolbar({ labels, selectedNodeId, onAddNode, onRemoveNode,
//                         onAddGate }): ReactElement

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  FlowEditorToolbar,
  editorEdgeStyle,
  isBackEdgeOutcome,
} from "@/components/flows/flow-graph-editor";
import { GATE_KINDS, NODE_TYPES } from "@/lib/flows/editor/node-form";

type ToolbarProps = Parameters<typeof FlowEditorToolbar>[0];

const labels: ToolbarProps["labels"] = {
  addNode: "Add node",
  removeNode: "Remove node",
  addGate: "Add gate",
  selectNodeHint: "Select a node to add a gate",
  nodeType: {
    ai_coding: "AI coding",
    cli: "CLI",
    check: "Check",
    judge: "Judge",
    human: "Human",
  },
  gateKind: {
    command_check: "Command check",
    skill_check: "Skill check",
    ai_judgment: "AI judgment",
    artifact_required: "Artifact required",
    external_check: "External check",
    human_review: "Human review",
  },
};

function render(selectedNodeId: string | null): string {
  return renderToStaticMarkup(
    createElement(FlowEditorToolbar, {
      labels,
      selectedNodeId,
      onAddNode: () => {},
      onRemoveNode: () => {},
      onAddGate: () => {},
    }),
  );
}

describe("FlowEditorToolbar — edit affordances", () => {
  it("renders the toolbar container", () => {
    expect(render(null)).toContain('data-testid="flow-editor-toolbar"');
  });

  it("renders an add-node affordance for every node type with its label", () => {
    const html = render(null);

    for (const type of NODE_TYPES) {
      expect(html).toContain(`data-testid="add-node-${type}"`);
    }
    expect(html).toContain("AI coding");
    expect(html).toContain("Human");
  });

  it("renders an add-gate affordance for every gate kind with its label", () => {
    const html = render("plan");

    for (const kind of GATE_KINDS) {
      expect(html).toContain(`data-testid="add-gate-${kind}"`);
    }
    expect(html).toContain("Command check");
    expect(html).toContain("Human review");
  });
});

describe("editorEdgeStyle — outcome-derived edge styling (T1.2)", () => {
  it("renders back-edge outcomes dashed + animated + amber", () => {
    for (const outcome of ["rework", "takeover", "reject"]) {
      const s = editorEdgeStyle(outcome);

      expect(s.animated).toBe(true);
      expect(s.style.strokeDasharray).toBeDefined();
      expect(s.style.stroke).toContain("attention");
    }
  });

  it("renders forward outcomes solid (no dash, not animated)", () => {
    for (const outcome of ["success", "failure", "custom_exit", ""]) {
      const s = editorEdgeStyle(outcome);

      expect(s.animated).toBe(false);
      expect(s.style.strokeDasharray).toBeUndefined();
      expect(s.style.stroke).toContain("mute-2");
    }
  });

  it("classifies back-edges case-insensitively and trimmed", () => {
    expect(isBackEdgeOutcome(" Rework ")).toBe(true);
    expect(isBackEdgeOutcome("TAKEOVER")).toBe(true);
    expect(isBackEdgeOutcome("success")).toBe(false);
    expect(isBackEdgeOutcome("approve")).toBe(false);
  });
});

describe("FlowEditorToolbar — selection gating", () => {
  it("disables remove-node and gate affordances and shows the hint when nothing is selected", () => {
    const html = render(null);

    expect(html).toContain('data-testid="remove-node"');
    expect(html).toContain('data-disabled="true"');
    expect(html).toContain("Select a node to add a gate");
  });

  it("enables remove-node when a node is selected and drops the hint", () => {
    const html = render("plan");

    expect(html).toContain('data-testid="remove-node"');
    expect(html).toContain('data-disabled="false"');
    expect(html).not.toContain("Select a node to add a gate");
  });
});
