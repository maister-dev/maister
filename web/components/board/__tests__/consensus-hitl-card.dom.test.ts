// @vitest-environment jsdom

// P0-5: the consensus card's decision routing, driven through real DOM clicks.
// Stable slots are the contract: a disabled middle slot must neither fire nor
// shift the decision the next slot sends.

import type { Root } from "react-dom/client";

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { HitlDecisionControls } from "@/components/board/hitl-decision-controls";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.innerHTML = "";
});

const SCHEMA = {
  kind: "consensus_resolution",
  round: 1,
  allowedDecisions: [
    "pick-draft-1",
    "pick-draft-2",
    "pick-draft-3",
    "provide-resolution",
    "abort",
  ],
  drafts: [
    {
      decision: "pick-draft-1",
      slot: 1,
      classification: "partial",
      stopReason: "max_tokens",
      excerpt: "Partial",
    },
    { decision: "pick-draft-2", slot: 2, classification: "unavailable" },
    {
      decision: "pick-draft-3",
      slot: 3,
      classification: "complete",
      excerpt: "Complete",
    },
  ],
  disagreements: [{ axis: "scope", summary: "Scope differs" }],
  technicalFailures: [],
};

function mount(onDecision: (decision: string) => void): HTMLElement {
  const container = document.createElement("div");

  document.body.appendChild(container);
  const root = createRoot(container);

  roots.push(root);
  act(() =>
    root.render(
      createElement(HitlDecisionControls, {
        kind: "human",
        reviewSchema: null,
        options: [],
        schema: SCHEMA,
        comments: "",
        jsonValue: "{}",
        formValues: {},
        disabled: false,
        error: null,
        labels: {
          criticalityLabel: "",
          "criticality.low": "",
          "criticality.medium": "",
          "criticality.high": "",
          "criticality.critical": "",
          reviewComments: "",
          decisionApprove: "",
          decisionRework: "",
          sendBackWithComments: "",
          responseLabel: "",
          responseHint: "",
          schemaLabel: "",
          submit: "",
          reviewCommentsPlaceholder: "",
          formInstructions: "",
          formCustomPlaceholder: "",
        },
        onCommentsChange: vi.fn(),
        onJsonChange: vi.fn(),
        onFormFieldChange: vi.fn(),
        onDecision,
        onSendBack: vi.fn(),
        onOption: vi.fn(),
        onSubmitJson: vi.fn(),
        onSubmitForm: vi.fn(),
      }),
    ),
  );

  return container;
}

function button(container: HTMLElement, slot: number): HTMLButtonElement {
  const found = container.querySelector<HTMLButtonElement>(
    `[data-testid="consensus-pick-draft-${slot}"]`,
  );

  expect(found).not.toBeNull();

  return found as HTMLButtonElement;
}

describe("consensus card decision routing", () => {
  it("sends the slot's own decision past a disabled middle slot", () => {
    const onDecision = vi.fn();
    const container = mount(onDecision);

    act(() => button(container, 3).click());
    act(() => button(container, 1).click());

    expect(onDecision.mock.calls).toEqual([["pick-draft-3"], ["pick-draft-1"]]);
  });

  it("never fires an unavailable slot", () => {
    const onDecision = vi.fn();
    const container = mount(onDecision);
    const unavailable = button(container, 2);

    expect(unavailable.disabled).toBe(true);
    expect(unavailable.getAttribute("aria-disabled")).toBe("true");
    act(() => unavailable.click());

    expect(onDecision).not.toHaveBeenCalled();
  });
});
