import { readFileSync } from "node:fs";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
  useTranslations: (namespace: string) => (key: string) =>
    `${namespace}.${key}`,
}));

import {
  NodeInterruptControls,
  type NodeInterruptControlsProps,
} from "@/components/runs/node-interrupt-controls";

// ADR-161 UI: the option set is SERVER-owned. These assert the component
// renders what it is given and never re-derives availability.

const base: NodeInterruptControlsProps = {
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
  onRespond: () => {},
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

// Codex finding 8 — `fresh-attempt`/`rewind` restart runs `reset --hard` +
// `git clean -fd`, and `stop` terminalizes the run. Both are irreversible from
// the UI, so a single misclick must not fire them. web/CLAUDE.md makes the
// shared portaled confirmation the house rule for destructive actions.
describe("NodeInterruptControls — irreversible actions confirm first", () => {
  function clickTag(html: string, label: string): string {
    const idx = html.indexOf(label);

    expect(idx).toBeGreaterThan(-1);

    return html.slice(html.lastIndexOf("<button", idx), idx);
  }

  it("does not render a confirmation until an irreversible option is chosen", () => {
    const html = render();

    expect(html).not.toContain("node-interrupt-confirm");
  });

  // The one-click default stays one-click: `keep` mutates nothing.
  it("leaves a keep-policy restart and resume unconfirmed", () => {
    const html = render();

    expect(clickTag(html, "nodeInterrupt.restartNode")).toContain("<button");
    expect(html).not.toContain("nodeInterrupt.confirmRestartTitle");
    expect(html).not.toContain("nodeInterrupt.confirmStopTitle");
  });

  // Static render cannot click, so the fence is on the wiring: every option
  // button routes through requestRespond, and the dialog copy exists for the
  // two irreversible cases.
  it("carries distinct confirmation copy for stop and for a destructive restart", () => {
    const en = JSON.parse(
      readFileSync(
        new URL("../../../messages/en.json", import.meta.url),
        "utf8",
      ),
    ) as { nodeInterrupt: Record<string, string> };

    for (const key of [
      "confirmStopTitle",
      "confirmStopBody",
      "confirmRestartTitle",
      "confirmRestartBody",
      "confirmAccept",
      "confirmCancel",
    ]) {
      expect(en.nodeInterrupt[key]).toBeTruthy();
    }
    // The restart copy must NAME the irreversible effect, not just say "are you
    // sure" — the operator is deciding whether uncommitted work survives.
    expect(en.nodeInterrupt.confirmRestartBody).toMatch(/untracked|lost/i);
  });
});
