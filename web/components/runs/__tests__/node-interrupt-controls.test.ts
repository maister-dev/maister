import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
  useTranslations: (namespace: string) => (key: string) =>
    `${namespace}.${key}`,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

import {
  NodeInterruptControls,
  type NodeInterruptControlsProps,
} from "@/components/runs/node-interrupt-controls";

// ADR-160 UI: the option set is SERVER-owned. These assert the component
// renders what it is given and never re-derives availability.

const base: NodeInterruptControlsProps = {
  runId: "run-1",
  hitlRequestId: "hitl-1",
  interruptedNodeId: "implement",
  defaultOptionId: "restart_node",
  options: [
    { optionId: "resume", enabled: true, disabledReason: null },
    { optionId: "restart_node", enabled: true, disabledReason: null },
    { optionId: "restart_from", enabled: true, disabledReason: null },
    { optionId: "stop", enabled: true, disabledReason: null },
  ],
  restartTargets: [
    { nodeId: "plan", recommended: true },
    { nodeId: "checks", recommended: false },
  ],
  canAct: true,
};

function render(over: Partial<NodeInterruptControlsProps> = {}): string {
  return renderToStaticMarkup(
    createElement(NodeInterruptControls, { ...base, ...over }),
  );
}

describe("NodeInterruptControls", () => {
  it("renders the one-click default plus resume and stop", () => {
    const html = render();

    expect(html).toContain("nodeInterrupt.restartNode");
    expect(html).toContain("nodeInterrupt.resume");
    expect(html).toContain("nodeInterrupt.stop");
    // The default is marked so the obvious action stays obvious.
    expect(html).toContain("nodeInterrupt.default");
  });

  it("offers a correction textarea and a workspace-policy selector", () => {
    const html = render();

    expect(html).toContain("nodeInterrupt.correctionLabel");
    expect(html).toContain("nodeInterrupt.workspacePolicyLabel");
    expect(html).toContain("nodeInterrupt.policyKeep");
    expect(html).toContain("nodeInterrupt.policyRewind");
    expect(html).toContain("nodeInterrupt.policyFresh");
  });

  // Progressive disclosure: the rarer jump-back must not compete with the
  // one-click default.
  it("keeps restart_from behind a disclosure toggle", () => {
    const html = render();

    expect(html).toContain("nodeInterrupt.showRestartFrom");
    // The target selector is not rendered until the toggle is opened.
    expect(html).not.toContain("nodeInterrupt.targetLabel");
  });

  it("hides the disclosure entirely when the server offers no targets", () => {
    const html = render({
      restartTargets: [],
      options: base.options.map((o) =>
        o.optionId === "restart_from"
          ? {
              ...o,
              enabled: false,
              disabledReason: "no earlier node has run in this run yet",
            }
          : o,
      ),
    });

    expect(html).not.toContain("nodeInterrupt.showRestartFrom");
    expect(html).toContain("no earlier node has run in this run yet");
  });

  it("disables the restart options and shows the cap reason at the safety cap", () => {
    const capped = "this run has already used 10 operator restarts";
    const html = render({
      options: base.options.map((o) =>
        o.optionId === "restart_node" || o.optionId === "restart_from"
          ? { ...o, enabled: false, disabledReason: capped }
          : o,
      ),
    });

    expect(html).toContain("disabled=");
    expect(html).toContain(capped);
    // resume and stop are never capped — the operator can always let it run on
    // or stop it.
    expect(html).toContain("nodeInterrupt.resume");
    expect(html).toContain("nodeInterrupt.stop");
  });

  it("disables every action when the viewer cannot act", () => {
    const html = render({ canAct: false });

    expect(html).toContain("disabled=");
  });
});
