// T3.4 (RED): failing unit tests for the PURE flow-graph-view layout/transform
// helpers (Track A, Phase 3). The React Flow canvas + live coloring is covered
// by the component render test + e2e; this file runs in node and tests only the
// pure transform (`toFlowGraphView`), the color map (`colorForNodeStatus`), and
// the terminal-status predicate (`isTerminalRunStatus`).
//
// Contract (module not built yet — RED on the missing import):
//   web/lib/board/flow-graph-view-layout.ts exports
//     toFlowGraphView(topology, layoutOverrides): { nodes: Node[]; edges: Edge[] }
//     colorForNodeStatus(status, isCurrent): FlowChipColor
//     isTerminalRunStatus(status): boolean
//     RUN_TERMINAL_STATUSES: readonly string[]

import type { GraphTopology } from "@/lib/queries/flow-graph-view";

import { describe, expect, it } from "vitest";

import {
  colorForNodeStatus,
  isTerminalRunStatus,
  RUN_TERMINAL_STATUSES,
  toFlowGraphView,
} from "@/lib/board/flow-graph-view-layout";

// A three-node chain plan -> implement -> review, with a rework edge back from
// review to plan so a multi-outcome topology is exercised.
function sampleTopology(): GraphTopology {
  return {
    nodes: [
      {
        id: "plan",
        nodeType: "ai_coding",
        label: "plan",
        displayLabel: "Plan",
        nodeTypeLabel: "Agent",
        nodeRole: "agent",
        declaredGateSummary: {
          total: 0,
          blocking: 0,
          advisory: 0,
          kinds: [],
        },
      },
      {
        id: "implement",
        nodeType: "ai_coding",
        label: "implement",
        displayLabel: "Implement",
        nodeTypeLabel: "Agent",
        nodeRole: "agent",
        declaredGateSummary: {
          total: 2,
          blocking: 1,
          advisory: 1,
          kinds: ["command_check", "skill_check"],
        },
      },
      {
        id: "review",
        nodeType: "human",
        label: "review",
        displayLabel: "Review",
        nodeTypeLabel: "Human review",
        nodeRole: "human",
        declaredGateSummary: {
          total: 0,
          blocking: 0,
          advisory: 0,
          kinds: [],
        },
      },
    ],
    edges: [
      {
        id: "plan:default",
        source: "plan",
        target: "implement",
        outcome: "default",
        displayLabel: "Default",
        edgeRole: "default",
      },
      {
        id: "implement:default",
        source: "implement",
        target: "review",
        outcome: "default",
        displayLabel: "Default",
        edgeRole: "default",
      },
      {
        id: "review:reject",
        source: "review",
        target: "plan",
        outcome: "reject",
        displayLabel: "Reject",
        edgeRole: "reject",
      },
      {
        id: "review:custom_exit",
        source: "review",
        target: "implement",
        outcome: "custom_exit",
        displayLabel: "Custom exit",
        edgeRole: "other",
      },
    ],
  } as unknown as GraphTopology;
}

describe("toFlowGraphView — base nodes/edges", () => {
  it("maps every topology node to a flowNode with data {label,nodeType} and type 'flowNode'", () => {
    const topology = sampleTopology();
    const { nodes } = toFlowGraphView(topology, {});

    expect(nodes).toHaveLength(topology.nodes.length);

    const plan = nodes.find((n) => n.id === "plan");

    expect(plan).toBeDefined();
    expect(plan?.type).toBe("flowNode");
    const data = plan?.data as Record<string, unknown>;

    expect(data.label).toBe("plan");
    expect(data.nodeType).toBe("ai_coding");
  });

  it("carries visual node metadata in React Flow data", () => {
    const topology = sampleTopology();
    const { nodes } = toFlowGraphView(topology, {});
    const implement = nodes.find((n) => n.id === "implement");
    const data = implement?.data as Record<string, unknown>;

    expect(data.displayLabel).toBe("Implement");
    expect(data.nodeTypeLabel).toBe("Agent");
    expect(data.nodeRole).toBe("agent");
    expect(data.declaredGateSummary).toEqual({
      total: 2,
      blocking: 1,
      advisory: 1,
      kinds: ["command_check", "skill_check"],
    });
  });

  it("maps every topology edge preserving id/source/target and carrying {outcome} in data", () => {
    const topology = sampleTopology();
    const { edges } = toFlowGraphView(topology, {});

    expect(edges).toHaveLength(topology.edges.length);

    const byId = new Map(edges.map((e) => [e.id, e]));

    for (const src of topology.edges) {
      const mapped = byId.get(src.id);

      expect(mapped).toBeDefined();
      expect(mapped?.source).toBe(src.source);
      expect(mapped?.target).toBe(src.target);
      expect(
        (mapped?.data as Record<string, unknown> | undefined)?.outcome,
      ).toBe(src.outcome);
    }
  });

  it("carries visual edge metadata and styles review-loop edges", () => {
    const topology = sampleTopology();
    const { edges } = toFlowGraphView(topology, {});
    const reject = edges.find((e) => e.id === "review:reject");
    const data = reject?.data as Record<string, unknown>;

    expect(data.displayLabel).toBe("Reject");
    expect(data.edgeRole).toBe("reject");
    expect(reject?.animated).toBe(true);
    expect(reject?.className).toContain("flow-edge--reject");
  });

  it("keeps custom/unknown outcome metadata without throwing", () => {
    const topology = sampleTopology();
    const { edges } = toFlowGraphView(topology, {});
    const custom = edges.find((e) => e.id === "review:custom_exit");
    const data = custom?.data as Record<string, unknown>;

    expect(data.displayLabel).toBe("Custom exit");
    expect(data.edgeRole).toBe("other");
    expect(custom?.source).toBe("review");
    expect(custom?.target).toBe("implement");
  });
});

describe("toFlowGraphView — dagre baseline (no overrides)", () => {
  it("lays out every node off the origin with numeric, distinct positions", () => {
    const topology = sampleTopology();
    const { nodes } = toFlowGraphView(topology, {});

    for (const node of nodes) {
      expect(typeof node.position.x).toBe("number");
      expect(Number.isFinite(node.position.x)).toBe(true);
      expect(typeof node.position.y).toBe("number");
      expect(Number.isFinite(node.position.y)).toBe(true);
    }

    // A multi-node LR chain must spread out — not every node parked at (0,0).
    const positions = new Set(
      nodes.map((n) => `${n.position.x},${n.position.y}`),
    );

    expect(positions.size).toBeGreaterThan(1);

    // The downstream node sits to the right of its upstream (rankdir LR).
    const plan = nodes.find((n) => n.id === "plan")!;
    const implement = nodes.find((n) => n.id === "implement")!;

    expect(implement.position.x).toBeGreaterThan(plan.position.x);
  });
});

describe("toFlowGraphView — layout overrides", () => {
  it("an override for an existing node sets that node's exact {x,y}; un-overridden nodes keep dagre", () => {
    const topology = sampleTopology();

    const baseline = toFlowGraphView(topology, {});
    const baselineImplement = baseline.nodes.find((n) => n.id === "implement")!;

    const overridden = toFlowGraphView(topology, { plan: { x: 999, y: 123 } });

    const plan = overridden.nodes.find((n) => n.id === "plan")!;

    expect(plan.position).toEqual({ x: 999, y: 123 });

    // The un-overridden node keeps its dagre-seeded position (unchanged).
    const implement = overridden.nodes.find((n) => n.id === "implement")!;

    expect(implement.position).toEqual(baselineImplement.position);
  });

  it("ignores an override for a node id NOT in the topology (no phantom node)", () => {
    const topology = sampleTopology();
    const { nodes } = toFlowGraphView(topology, {
      "ghost-node": { x: 10, y: 20 },
    });

    expect(nodes).toHaveLength(topology.nodes.length);
    expect(nodes.find((n) => n.id === "ghost-node")).toBeUndefined();
  });
});

describe("colorForNodeStatus", () => {
  it("maps each known status to its chip color", () => {
    expect(colorForNodeStatus("Running", false)).toBe("accent");
    expect(colorForNodeStatus("Succeeded", false)).toBe("success");
    expect(colorForNodeStatus("Failed", false)).toBe("danger");
    expect(colorForNodeStatus("NeedsInput", false)).toBe("warning");
    expect(colorForNodeStatus("Reworked", false)).toBe("warning");
    expect(colorForNodeStatus("Stale", false)).toBe("default");
    expect(colorForNodeStatus("Pending", false)).toBe("default");
  });

  it("falls back to default for an unknown status", () => {
    expect(colorForNodeStatus("WeirdUnknown", false)).toBe("default");
  });

  it("bumps a current Pending/unknown node to accent (active-node emphasis)", () => {
    expect(colorForNodeStatus("Pending", true)).toBe("accent");
    expect(colorForNodeStatus("WeirdUnknown", true)).toBe("accent");
  });

  it("does NOT override a resolved status when current (a current Succeeded stays success)", () => {
    expect(colorForNodeStatus("Succeeded", true)).toBe("success");
  });
});

describe("isTerminalRunStatus / RUN_TERMINAL_STATUSES", () => {
  it("is true for each terminal run status", () => {
    for (const status of ["Done", "Failed", "Abandoned", "Crashed"]) {
      expect(isTerminalRunStatus(status)).toBe(true);
    }
  });

  it("is false for live run statuses", () => {
    for (const status of ["Running", "NeedsInput", "Pending", "Review"]) {
      expect(isTerminalRunStatus(status)).toBe(false);
    }
  });

  it("RUN_TERMINAL_STATUSES lists exactly Done/Failed/Abandoned/Crashed", () => {
    expect([...RUN_TERMINAL_STATUSES].sort()).toEqual(
      ["Abandoned", "Crashed", "Done", "Failed"].sort(),
    );
  });
});
