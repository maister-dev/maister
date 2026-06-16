import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PanelSection } from "@/components/settings/panel-section";

describe("PanelSection", () => {
  it("renders the title, actions, the underline rule, and children", () => {
    const markup = renderToStaticMarkup(
      createElement(
        PanelSection,
        { title: "Sources", actions: createElement("button", {}, "Add") },
        createElement("p", {}, "body"),
      ),
    );

    expect(markup).toContain("Sources");
    expect(markup).toContain("Add");
    expect(markup).toContain("body");
    // Variant A: header carries the rule (border-b), not an orphan border-t.
    expect(markup).toContain("border-b border-line");
    expect(markup).not.toContain("border-t");
  });

  it("omits the actions slot when no actions are passed", () => {
    const markup = renderToStaticMarkup(
      createElement(
        PanelSection,
        { title: "Solo" },
        createElement("p", {}, "x"),
      ),
    );

    expect(markup).toContain("Solo");
    expect(markup).toContain("x");
    // The actions wrapper is the only `gap-2` element in the frame.
    expect(markup).not.toContain("gap-2");
  });
});
