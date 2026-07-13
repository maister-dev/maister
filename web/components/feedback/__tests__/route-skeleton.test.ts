import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { RouteSkeleton } from "@/components/feedback/route-skeleton";

describe("RouteSkeleton", () => {
  it.each(["portfolio", "run", "project", "studio", "inbox"] as const)(
    "renders a non-empty %s loading geometry",
    (variant) => {
      const html = renderToStaticMarkup(
        createElement(RouteSkeleton, { variant }),
      );

      expect(html).toContain('aria-busy="true"');
      expect(html).toContain(`data-testid="route-skeleton-${variant}"`);
      expect(html).toContain("animate-pulse");
    },
  );
});
