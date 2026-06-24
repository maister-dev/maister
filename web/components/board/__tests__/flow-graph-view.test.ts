// Render tests for the PRESENTATIONAL flow-node body (Track A, Phase 3) PLUS
// the static-vs-run-coupled split of the full `FlowGraphView` (T1.2). Uses
// renderToStaticMarkup (no jsdom), mirroring
// components/run/__tests__/readiness-summary.test.ts.
//
// `FlowNodeBody` is the named, presentational export with NO `<Handle>` and NO
// ReactFlow context. The full `FlowGraphView` DOES render under
// renderToStaticMarkup: React Flow server-renders the node bodies (no DOM
// measurement needed for the static markup), so the run-mode chips/current-ring
// and the static-mode topology-only render are both assertable here. Drag
// persistence + live-coloring behavior remains the e2e's job (T6.2).
//
// Contract:
//   web/components/board/flow-graph-view.tsx exports
//     default FlowGraphView({ topology, layout, labels, runContext? })
//       runContext PRESENT → run-coupled (SSE + /graph-status, status chips,
//         current-node ring); runContext ABSENT → static mode (pure topology +
//         presentation layout, no subscription, no chips, no ring).
//     FlowNodeBody({ label, status, isCurrent, rollup, labels }): ReactElement
//
// `Chip` from @heroui/react renders cleanly under renderToStaticMarkup in node
// (verified: emits `<span class="chip chip--<color> ...">`), so the test asserts
// on the emitted data attributes, the chip color class, and the label text —
// never chip internals.

import type { GraphTopology } from "@/lib/queries/flow-graph-view";
import type { RunNodeStatuses } from "@/lib/queries/run-node-status";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import FlowGraphView, {
  FlowEdgeLabel,
  FlowNodeBody,
  applyFlowGraphStatusSnapshot,
  resolveFlowEdgeLabel,
} from "@/components/board/flow-graph-view";

type FlowNodeBodyProps = {
  label: string;
  nodeType?: string;
  displayLabel?: string;
  nodeTypeLabel?: string;
  nodeRole?: string;
  status: string;
  isCurrent: boolean;
  rollup: string;
  declaredGateSummary?: {
    total: number;
    blocking: number;
    advisory: number;
    kinds: string[];
  };
  runtimeGateSummary?: {
    total: number;
    blockingTotal: number;
    advisoryTotal: number;
    worstBlockingStatus: string | null;
    failedBlocking: number;
    staleBlocking: number;
  };
  labels: {
    currentNode: string;
    gateSummary?: string;
    blockingGateSummary?: string;
    declaredGateSummary?: string;
  };
};

const baseLabels: FlowNodeBodyProps["labels"] = {
  currentNode: "Current node",
  gateSummary: "$count gates",
  blockingGateSummary: "$count blocking",
  declaredGateSummary: "$count declared gates",
};

function render(props: FlowNodeBodyProps): string {
  return renderToStaticMarkup(createElement(FlowNodeBody, props));
}

describe("FlowNodeBody — node status rendering", () => {
  it("renders a Running node with the accent chip color and the label text", () => {
    const html = render({
      label: "implement",
      status: "Running",
      isCurrent: false,
      rollup: "none",
      labels: baseLabels,
    });

    expect(html).toContain('data-testid="flow-node"');
    expect(html).toContain('data-node-status="Running"');
    expect(html).toContain("implement");
    // accent color affordance from colorForNodeStatus("Running", false).
    expect(html).toContain("chip--accent");
  });

  it("renders a Succeeded node with the success chip color", () => {
    const html = render({
      label: "review",
      status: "Succeeded",
      isCurrent: false,
      rollup: "none",
      labels: baseLabels,
    });

    expect(html).toContain('data-node-status="Succeeded"');
    expect(html).toContain("chip--success");
  });
});

describe("FlowNodeBody — node type icon chip (T1.1)", () => {
  it("renders the colored type icon chip coexisting with the run-status chip", () => {
    const html = render({
      label: "implement",
      nodeType: "ai_coding",
      status: "Running",
      isCurrent: false,
      rollup: "none",
      labels: baseLabels,
    });

    // Heym-style accent: the type-colored top bar + bare icon both carry the
    // ai_coding canvas hue (no separate chip background).
    expect(html).toContain('data-testid="node-type-icon"');
    expect(html).toContain('data-node-type="ai_coding"');
    expect(html).toContain('data-testid="node-type-bar"');
    expect(html).toContain("var(--cv-green)");
    // ...AND the run-status chip is unchanged (composition, not replacement).
    expect(html).toContain("chip--accent");
    expect(html).toContain('data-node-status="Running"');
  });

  it("falls back to a neutral dot token for an unknown node type", () => {
    const html = render({
      label: "plan",
      nodeType: "mystery",
      status: "Pending",
      isCurrent: false,
      rollup: "none",
      labels: baseLabels,
    });

    expect(html).toContain('data-node-type="mystery"');
    expect(html).toContain("var(--cv-gray)");
  });

  it("omits the icon chip entirely when no node type is provided", () => {
    const html = render({
      label: "plan",
      status: "Pending",
      isCurrent: false,
      rollup: "none",
      labels: baseLabels,
    });

    expect(html).not.toContain('data-testid="node-type-icon"');
  });
});

describe("FlowNodeBody — visual graph metadata", () => {
  it("renders display label and node type label instead of only the raw node id", () => {
    const html = render({
      label: "implement-work",
      displayLabel: "Implement work",
      nodeTypeLabel: "Agent",
      nodeRole: "agent",
      status: "Running",
      isCurrent: false,
      rollup: "none",
      labels: baseLabels,
    });

    expect(html).toContain("Implement work");
    expect(html).toContain("Agent");
    expect(html).toContain('data-node-role="agent"');
  });

  it("renders declared and runtime gate summaries visibly", () => {
    const html = render({
      label: "checks",
      displayLabel: "Checks",
      nodeTypeLabel: "Check",
      nodeRole: "check",
      status: "Failed",
      isCurrent: false,
      rollup: "failed",
      declaredGateSummary: {
        total: 2,
        blocking: 1,
        advisory: 1,
        kinds: ["command_check", "skill_check"],
      },
      runtimeGateSummary: {
        total: 2,
        blockingTotal: 1,
        advisoryTotal: 1,
        worstBlockingStatus: "failed",
        failedBlocking: 1,
        staleBlocking: 0,
      },
      labels: baseLabels,
    });

    expect(html).toContain("2 declared gates");
    expect(html).toContain("2 gates");
    expect(html).toContain("1 blocking");
    expect(html).toContain('data-testid="gate-rollup"');
  });

  it("uses non-ICU count templates so server translations do not require values", () => {
    const html = render({
      label: "checks",
      status: "Running",
      isCurrent: false,
      rollup: "none",
      declaredGateSummary: {
        total: 1,
        blocking: 1,
        advisory: 0,
        kinds: ["command_check"],
      },
      runtimeGateSummary: {
        total: 1,
        blockingTotal: 1,
        advisoryTotal: 0,
        worstBlockingStatus: "passed",
        failedBlocking: 0,
        staleBlocking: 0,
      },
      labels: {
        currentNode: "Current node",
        declaredGateSummary: "$count declared gates",
        gateSummary: "$count gates",
        blockingGateSummary: "$count blocking",
      },
    });

    expect(html).toContain("1 declared gates");
    expect(html).toContain("1 gates");
    expect(html).toContain("1 blocking");
    expect(html).not.toContain("$count");
  });
});

describe("FlowNodeBody — gate rollup badge", () => {
  it("renders the gate-rollup badge for a failed rollup", () => {
    const html = render({
      label: "implement",
      status: "Failed",
      isCurrent: false,
      rollup: "failed",
      labels: baseLabels,
    });

    expect(html).toContain('data-testid="gate-rollup"');
    expect(html).toContain('data-rollup="failed"');
  });

  it("renders the gate-rollup badge for a stale rollup", () => {
    const html = render({
      label: "implement",
      status: "Reworked",
      isCurrent: false,
      rollup: "stale",
      labels: baseLabels,
    });

    expect(html).toContain('data-testid="gate-rollup"');
    expect(html).toContain('data-rollup="stale"');
  });

  it("does NOT render the gate-rollup badge for a passing node (rollup none)", () => {
    const html = render({
      label: "plan",
      status: "Succeeded",
      isCurrent: false,
      rollup: "none",
      labels: baseLabels,
    });

    expect(html).not.toContain('data-testid="gate-rollup"');
  });
});

describe("FlowNodeBody — translated status surfaced as a tooltip", () => {
  it("renders the statusLabel as a title so status is not conveyed by color alone", () => {
    const html = renderToStaticMarkup(
      createElement(FlowNodeBody, {
        label: "implement",
        status: "Running",
        statusLabel: "Выполняется",
        isCurrent: false,
        rollup: "none",
        labels: baseLabels,
      } as FlowNodeBodyProps & { statusLabel: string }),
    );

    expect(html).toContain('title="Выполняется"');
  });
});

describe("FlowNodeBody — current-node emphasis", () => {
  it("marks the current node with data-current=true and aria-current", () => {
    const html = render({
      label: "implement",
      status: "Running",
      isCurrent: true,
      rollup: "none",
      labels: baseLabels,
    });

    expect(html).toContain('data-current="true"');
    expect(html).toContain("aria-current");
  });

  it("does not add current emphasis for a non-current node", () => {
    const html = render({
      label: "implement",
      status: "Running",
      isCurrent: false,
      rollup: "none",
      labels: baseLabels,
    });

    expect(html).toContain('data-current="false"');
    expect(html).not.toContain("aria-current");
  });
});

describe("FlowEdgeLabel — visual edge metadata", () => {
  it("renders the edge label with role-specific data attributes", () => {
    const html = renderToStaticMarkup(
      createElement(FlowEdgeLabel, {
        label: "Rework",
        edgeRole: "rework",
      }),
    );

    expect(html).toContain("Rework");
    expect(html).toContain('data-edge-role="rework"');
    expect(html).toContain('data-testid="flow-edge-label"');
  });

  it("prefers the custom display label for unknown edge roles", () => {
    const label = resolveFlowEdgeLabel(
      {
        edge: {
          other: "Other",
        },
      },
      {
        displayLabel: "Custom exit",
        edgeRole: "other",
        outcome: "custom_exit",
      },
      "review:custom_exit",
    );

    expect(label).toBe("Custom exit");
  });
});

describe("FlowGraphView runtime snapshot state", () => {
  it("updates the local run status from graph-status snapshots", () => {
    const next = applyFlowGraphStatusSnapshot(
      {
        currentStep: "implement",
        runStatus: "Running",
        statuses: {},
      },
      {
        currentStepId: null,
        runStatus: "Done",
        nodes: {},
      },
    );

    expect(next.runStatus).toBe("Done");
    expect(next.currentStep).toBeNull();
  });
});

const graphViewLabels = {
  title: "Flow",
  empty: "Empty",
  currentNode: "Current node",
  node: { Pending: "Pending", Running: "Running", Succeeded: "Done" },
  role: { agent: "Agent" },
};

const oneNodeTopology: GraphTopology = {
  nodes: [
    {
      id: "plan",
      label: "plan",
      displayLabel: "Plan",
      nodeType: "agent",
      nodeTypeLabel: "Agent",
      nodeRole: "agent",
      declaredGateSummary: { total: 0, blocking: 0, advisory: 0, kinds: [] },
    },
  ],
  edges: [],
};

const runningStatus: RunNodeStatuses["nodes"] = {
  plan: {
    status: "Running",
    attempt: 1,
    autoRetry: false,
    gates: [],
    rollup: "none",
    gateSummary: {
      total: 0,
      blockingTotal: 0,
      advisoryTotal: 0,
      worstBlockingStatus: null,
      failedBlocking: 0,
      staleBlocking: 0,
    },
  },
};

describe("FlowGraphView — run-coupled vs static mode", () => {
  it("renders status chips and the current-node ring when runContext is present", () => {
    const html = renderToStaticMarkup(
      createElement(FlowGraphView, {
        topology: oneNodeTopology,
        layout: {},
        labels: graphViewLabels,
        nodeTooltips: {
          plan: "plan · ai_coding\nmodel: claude",
        },
        runContext: {
          runId: "run-1",
          initialStatuses: runningStatus,
          currentStepId: "plan",
          runStatus: "Running",
        },
      }),
    );

    expect(html).toContain('data-testid="flow-graph-view"');
    expect(html).toContain('data-testid="flow-node"');
    expect(html).toContain("Plan");
    // run-coupled affordances: status chip + current-node emphasis.
    expect(html).toContain('data-node-status="Running"');
    expect(html).toContain('data-current="true"');
    expect(html).toContain("chip--");
    expect(html).toContain('data-testid="flow-node-tooltip"');
    expect(html).toContain("claude");
  });

  it("renders pure topology with NO chips and NO current ring when runContext is absent (static mode)", () => {
    const html = renderToStaticMarkup(
      createElement(FlowGraphView, {
        topology: oneNodeTopology,
        layout: {},
        labels: graphViewLabels,
      }),
    );

    // The topology still renders (node body + presentation label).
    expect(html).toContain('data-testid="flow-graph-view"');
    expect(html).toContain('data-testid="flow-node"');
    expect(html).toContain("Plan");
    // Static mode emits NO run-coupled markup — the attributes are omitted
    // entirely, not just set false (a regression re-coupling status would
    // re-introduce `data-current`/`data-node-status` in any form).
    expect(html).not.toContain("chip--");
    expect(html).not.toContain("data-node-status");
    expect(html).not.toContain("data-current");
    expect(html).toContain("Plan · Agent");
  });

  it("uses authored node tooltips in static mode when they are available", () => {
    const html = renderToStaticMarkup(
      createElement(FlowGraphView, {
        topology: oneNodeTopology,
        layout: {},
        labels: graphViewLabels,
        nodeTooltips: {
          plan: "plan · ai_coding\nmodel: claude",
        },
      }),
    );

    expect(html).toContain('data-testid="flow-node-tooltip"');
    expect(html).toContain("claude");
  });
});
