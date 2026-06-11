// T3.4 (RED): render tests for the typed-edge connect modal + the pure
// duplicate-outcome helper. renderToStaticMarkup (no jsdom), mirroring
// components/flows/__tests__/node-side-form.test.ts. The modal's connect→edge
// behavior (focus-trap, Escape, confirm wiring) is the e2e's job (T5.1); here we
// assert only the static markup contract + the helper logic.
//
// Contract (module not built yet — RED on the missing imports):
//   web/components/flows/edge-connect-modal.tsx exports
//     EdgeConnectModal({ labels, source, target, duplicate, onConfirm,
//                        onCancel }): ReactElement
//   web/lib/flows/editor/editor-state.ts exports
//     outcomeExistsForSource(manifest, source, outcome): boolean

import type { FlowYamlV1 } from "@/lib/config.schema";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { EdgeConnectModal } from "@/components/flows/edge-connect-modal";
import { flowYamlV1Schema } from "@/lib/config.schema";
import { outcomeExistsForSource } from "@/lib/flows/editor/editor-state";

type ModalProps = Parameters<typeof EdgeConnectModal>[0];

const labels: ModalProps["labels"] = {
  title: "Connect nodes",
  outcome: "Outcome",
  suggestionsHint: "Common outcomes",
  freeTextHint: "Or type a custom outcome",
  retargetWarning: "This outcome already exists and will be retargeted",
  confirm: "Connect",
  cancel: "Cancel",
  suggestion: {
    success: "success",
    failure: "failure",
    rework: "rework",
    takeover: "takeover",
  },
};

function render(overrides?: Partial<ModalProps>): string {
  const props: ModalProps = {
    labels,
    source: "plan",
    target: "review",
    duplicate: false,
    onConfirm: () => {},
    onCancel: () => {},
    ...overrides,
  };

  return renderToStaticMarkup(createElement(EdgeConnectModal, props));
}

describe("EdgeConnectModal — markup", () => {
  it("renders the dialog with its title, aria-labelledby, and a testid", () => {
    const html = render();

    expect(html).toContain('data-testid="edge-connect-modal"');
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('aria-labelledby="edge-connect-modal-title"');
    expect(html).toContain('id="edge-connect-modal-title"');
    expect(html).toContain("Connect nodes");
  });

  it("renders the outcome free-text field defaulting to success", () => {
    const html = render();

    expect(html).toContain('data-testid="edge-connect-outcome"');
    expect(html).toContain("Outcome");
    // default value is `success`
    expect(html).toContain('value="success"');
  });

  it("renders a suggestion affordance for every common outcome", () => {
    const html = render();

    for (const outcome of ["success", "failure", "rework", "takeover"]) {
      expect(html).toContain(
        `data-testid="edge-connect-suggestion-${outcome}"`,
      );
    }
  });

  it("renders confirm and cancel affordances", () => {
    const html = render();

    expect(html).toContain('data-testid="edge-connect-confirm"');
    expect(html).toContain('data-testid="edge-connect-cancel"');
    expect(html).toContain("Connect");
    expect(html).toContain("Cancel");
  });

  it("hides the retarget warning when the outcome is new", () => {
    const html = render({ duplicate: false });

    expect(html).not.toContain('data-testid="edge-connect-retarget-warning"');
  });

  it("shows the retarget warning when the outcome duplicates an existing one", () => {
    const html = render({ duplicate: true });

    expect(html).toContain('data-testid="edge-connect-retarget-warning"');
    expect(html).toContain(
      "This outcome already exists and will be retargeted",
    );
  });
});

// ─── outcomeExistsForSource ──────────────────────────────────────────────────

const MANIFEST: FlowYamlV1 = flowYamlV1Schema.parse({
  schemaVersion: 1,
  name: "Test Flow",
  nodes: [
    {
      id: "plan",
      type: "ai_coding",
      action: { prompt: "do plan" },
      transitions: { success: "review" },
    },
    {
      id: "review",
      type: "human",
      settings: { decisions: ["approve"] },
    },
  ],
});

describe("outcomeExistsForSource", () => {
  it("returns true when the source already has a transition for the outcome", () => {
    expect(outcomeExistsForSource(MANIFEST, "plan", "success")).toBe(true);
  });

  it("returns false for an outcome the source does not yet have", () => {
    expect(outcomeExistsForSource(MANIFEST, "plan", "failure")).toBe(false);
  });

  it("returns false for a source node with no transitions", () => {
    expect(outcomeExistsForSource(MANIFEST, "review", "success")).toBe(false);
  });

  it("returns false for an unknown source id", () => {
    expect(outcomeExistsForSource(MANIFEST, "ghost", "success")).toBe(false);
  });
});
