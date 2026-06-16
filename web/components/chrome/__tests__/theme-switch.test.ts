import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ThemeModeIcon } from "@/components/chrome/theme-switch";

describe("ThemeModeIcon", () => {
  it("renders the light theme icon as a stroked sun instead of a filled dot", () => {
    const html = renderToStaticMarkup(
      createElement(ThemeModeIcon, { theme: "light" }),
    );

    expect(html).toContain('data-testid="theme-icon-light"');
    expect(html).toContain('stroke="currentColor"');
    expect(html).toContain('stroke-linecap="round"');
    expect(html).toContain("M8 2v1.5");
    expect(html).not.toContain('fill="currentColor"');
  });
});
