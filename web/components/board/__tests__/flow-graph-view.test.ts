// T3.4 (RED): failing render tests for the PRESENTATIONAL flow-node body
// (Track A, Phase 3). Uses renderToStaticMarkup (no jsdom), mirroring
// components/run/__tests__/readiness-summary.test.ts.
//
// We render ONLY `FlowNodeBody` — the named, presentational export with NO
// `<Handle>` and NO ReactFlow context. The full `FlowGraphView` (and the
// `<Handle>`-wrapped `makeFlowNodeView`) requires ReactFlow provider context and
// is NOT renderable via renderToStaticMarkup; drag persistence + live-coloring
// behavior is the e2e's job (T6.2).
//
// Contract (module not built yet — RED on the missing import):
//   web/components/board/flow-graph-view.tsx exports
//     default FlowGraphView   (client component, NOT rendered here)
//     FlowNodeBody({ label, status, isCurrent, rollup, labels }): ReactElement
//
// `Chip` from @heroui/react renders cleanly under renderToStaticMarkup in node
// (verified: emits `<span class="chip chip--<color> ...">`), so the test asserts
// on the emitted data attributes, the chip color class, and the label text —
// never chip internals.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  FlowEdgeLabel,
  FlowNodeBody,
  applyFlowGraphStatusSnapshot,
  resolveFlowEdgeLabel,
} from "@/components/board/flow-graph-view";

type FlowNodeBodyProps = {
  label: string;
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
