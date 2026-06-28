import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  CapabilityComposer,
  shouldResetComposerDocument,
  isSubmitShortcut,
} from "@/components/capabilities/capability-composer";

// T5.2: interactive behaviour is e2e-only (no DOM in the node lane); this only
// asserts the component mounts/SSRs without crashing and exposes its testId.
describe("CapabilityComposer — static render", () => {
  it("renders the wrapper with the given testId and does not throw", () => {
    const html = renderToStaticMarkup(
      createElement(CapabilityComposer, {
        value: "run @skill:aif-plan now",
        onChange: () => {},
        catalog: [],
        agent: "claude",
        labels: { placeholder: "type…", unsupportedBadge: "!" },
        testId: "test-composer",
      }),
    );

    expect(html).toContain('data-testid="test-composer"');
  });

  it("marks the wrapper as a protected React Flow interaction zone", () => {
    const html = renderToStaticMarkup(
      createElement(CapabilityComposer, {
        value: "do work",
        onChange: () => {},
        catalog: [],
        agent: "claude",
        labels: { placeholder: "type…", unsupportedBadge: "!" },
        testId: "test-composer",
      }),
    );

    expect(html).toMatch(
      /class="[^"]*capability-composer[^"]*nodrag[^"]*nopan[^"]*nowheel[^"]*nokey/u,
    );
  });

  it("renders a compact variable affordance only when editable catalog entries exist", () => {
    const html = renderToStaticMarkup(
      createElement(CapabilityComposer, {
        value: "",
        onChange: () => {},
        catalog: [],
        agent: "claude",
        labels: {
          placeholder: "type…",
          unsupportedBadge: "!",
          variableButton: "Variables",
        },
        variableCatalog: [
          {
            path: "steps.plan.output",
            label: "steps.plan.output",
            source: "step",
            availability: "definite",
            presence: "required",
            insertText: "steps.plan.output",
          },
          {
            path: "steps.plan.vars.notes",
            label: "steps.plan.vars.notes",
            source: "step",
            availability: "conditional",
            presence: "optional",
            insertText: "steps.plan.vars.notes ?? ''",
          },
        ],
        testId: "test-composer",
      }),
    );

    expect(html).toContain('data-testid="capability-variable-button"');
    expect(html).toContain('data-variable-path="steps.plan.output"');
    expect(html).toContain("steps.plan.vars.notes ?? &#x27;&#x27;");
  });

  it("does not expose variable controls when disabled or no catalog is present", () => {
    const disabledHtml = renderToStaticMarkup(
      createElement(CapabilityComposer, {
        value: "",
        onChange: () => {},
        catalog: [],
        agent: "claude",
        labels: {
          placeholder: "type…",
          unsupportedBadge: "!",
          variableButton: "Variables",
        },
        variableCatalog: [
          {
            path: "steps.plan.output",
            label: "steps.plan.output",
            source: "step",
            availability: "definite",
            presence: "required",
            insertText: "steps.plan.output",
          },
        ],
        disabled: true,
      }),
    );
    const noCatalogHtml = renderToStaticMarkup(
      createElement(CapabilityComposer, {
        value: "",
        onChange: () => {},
        catalog: [],
        agent: "claude",
        labels: {
          placeholder: "type…",
          unsupportedBadge: "!",
          variableButton: "Variables",
        },
      }),
    );

    expect(disabledHtml).not.toContain("capability-variable-button");
    expect(noCatalogHtml).not.toContain("capability-variable-button");
  });
});

describe("isSubmitShortcut", () => {
  const ev = (
    over: Partial<
      Pick<
        KeyboardEvent,
        "key" | "metaKey" | "ctrlKey" | "shiftKey" | "isComposing" | "keyCode"
      >
    >,
  ) => ({
    key: "Enter",
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    isComposing: false,
    keyCode: 13,
    ...over,
  });

  it("submits on plain Enter (chat convention)", () => {
    expect(isSubmitShortcut(ev({}))).toBe(true);
  });

  it("also submits on Cmd+Enter / Ctrl+Enter", () => {
    expect(isSubmitShortcut(ev({ metaKey: true }))).toBe(true);
    expect(isSubmitShortcut(ev({ ctrlKey: true }))).toBe(true);
  });

  it("does NOT submit on Shift+Enter (newline)", () => {
    expect(isSubmitShortcut(ev({ shiftKey: true }))).toBe(false);
  });

  it("does NOT submit while composing an IME candidate", () => {
    expect(isSubmitShortcut(ev({ isComposing: true }))).toBe(false);
    expect(isSubmitShortcut(ev({ keyCode: 229 }))).toBe(false);
  });

  it("ignores non-Enter keys", () => {
    expect(isSubmitShortcut(ev({ key: "k", metaKey: true }))).toBe(false);
  });
});

describe("shouldResetComposerDocument", () => {
  it("does not reset the editor when a local edit already matches the next value", () => {
    expect(
      shouldResetComposerDocument({
        currentCanonical: "compose regression",
        nextValue: "compose regression",
        currentDisplaySignature: "claude|skill:aif-plan:@skill:aif-plan:true",
        nextDisplaySignature: "claude|skill:aif-plan:@skill:aif-plan:true",
      }),
    ).toBe(false);
  });

  it("resets for external value changes and runner/catalog display changes", () => {
    expect(
      shouldResetComposerDocument({
        currentCanonical: "old",
        nextValue: "new",
        currentDisplaySignature: "claude|skill:aif-plan:@skill:aif-plan:true",
        nextDisplaySignature: "claude|skill:aif-plan:@skill:aif-plan:true",
      }),
    ).toBe(true);
    expect(
      shouldResetComposerDocument({
        currentCanonical: "compose regression",
        nextValue: "compose regression",
        currentDisplaySignature: "claude|skill:aif-plan:@skill:aif-plan:true",
        nextDisplaySignature: "codex|skill:aif-plan:$aif-plan:true",
      }),
    ).toBe(true);
  });
});
