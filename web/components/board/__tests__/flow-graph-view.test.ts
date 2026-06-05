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

import { FlowNodeBody } from "@/components/board/flow-graph-view";

type FlowNodeBodyProps = {
  label: string;
  status: string;
  isCurrent: boolean;
  rollup: string;
  labels: { currentNode: string };
};

const baseLabels: FlowNodeBodyProps["labels"] = {
  currentNode: "Current node",
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
