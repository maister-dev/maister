// Render tests for the presentational rail collapse shell (T1.3). Uses
// renderToStaticMarkup (no jsdom). The stateful `RailCollapse` wrapper (useState
// + localStorage) is exercised by the e2e (T1.7); here we assert the pure
// `RailCollapseView` markup differs by the `collapsed` flag.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { RailCollapseView } from "@/components/chrome/rail-collapse";

function render(collapsed: boolean): string {
  return renderToStaticMarkup(
    createElement(
      RailCollapseView,
      {
        collapsed,
        collapsedChildren: createElement(
          "span",
          { "data-testid": "rail-compact-child" },
          "Compact projects",
        ),
        onToggle: () => {},
        collapseLabel: "Collapse sidebar",
        expandLabel: "Expand sidebar",
      },
      createElement("span", { "data-testid": "rail-child" }, "Projects"),
    ),
  );
}

describe("RailCollapseView — collapse toggle (T1.3)", () => {
  it("renders the toggle button in both states", () => {
    expect(render(false)).toContain('data-testid="rail-collapse-toggle"');
    expect(render(true)).toContain('data-testid="rail-collapse-toggle"');
    expect(render(false)).toContain('data-testid="rail-collapse-icon"');
    expect(render(false)).toContain('viewBox="0 0 24 24"');
  });

  it("shows the rail content (nav labels) when expanded", () => {
    const html = render(false);

    expect(html).toContain('data-collapsed="false"');
    expect(html).toContain('data-testid="rail-content"');
    expect(html).toContain("Projects");
  });

  it("shows compact rail content when collapsed", () => {
    const html = render(true);

    expect(html).toContain('data-collapsed="true"');
    expect(html).toContain('data-testid="rail-collapsed-content"');
    expect(html).toContain("Compact projects");
    expect(html).not.toContain('data-testid="rail-content"');
    expect(html).not.toContain("Projects");
  });

  it("labels the toggle by the next action it performs", () => {
    expect(render(false)).toContain('title="Collapse sidebar"');
    expect(render(true)).toContain('title="Expand sidebar"');
  });
});
