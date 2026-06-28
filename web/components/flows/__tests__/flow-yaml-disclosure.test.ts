import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/components/flows/code-editor", () => ({
  CodeEditor: ({ value }: { value: string }) =>
    createElement("pre", { "data-testid": "code-editor" }, value),
}));

import { FlowYamlDisclosure } from "@/components/flows/flow-yaml-disclosure";

describe("FlowYamlDisclosure", () => {
  it("collapses the yaml by default behind a toggle button", () => {
    const markup = renderToStaticMarkup(
      createElement(FlowYamlDisclosure, {
        value: "schemaVersion: 1\nname: aif-dev\n",
        title: "flow.yaml",
        ariaLabel: "flow.yaml",
      }),
    );

    expect(markup).toContain("flow.yaml");
    expect(markup).toContain('data-testid="flow-yaml-toggle"');
    expect(markup).toContain('aria-expanded="false"');
    // Collapsed by default → the editor (and its content) is not rendered.
    expect(markup).not.toContain('data-testid="code-editor"');
    expect(markup).not.toContain("schemaVersion: 1");
  });
});
