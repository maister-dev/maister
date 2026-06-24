import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  CapabilityComposer,
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
});

describe("isSubmitShortcut", () => {
  it("accepts Cmd+Enter and Ctrl+Enter only", () => {
    expect(
      isSubmitShortcut({ key: "Enter", metaKey: true, ctrlKey: false }),
    ).toBe(true);
    expect(
      isSubmitShortcut({ key: "Enter", metaKey: false, ctrlKey: true }),
    ).toBe(true);
    expect(
      isSubmitShortcut({ key: "Enter", metaKey: false, ctrlKey: false }),
    ).toBe(false);
    expect(isSubmitShortcut({ key: "k", metaKey: true, ctrlKey: false })).toBe(
      false,
    );
  });
});
