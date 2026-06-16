import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CapabilityComposer } from "@/components/capabilities/capability-composer";

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
