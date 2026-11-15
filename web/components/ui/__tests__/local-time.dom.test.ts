import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { LocalTime } from "@/components/ui/local-time";

// The client-zone half is owned by the Playwright P-5 assertion with a fixed
// browser timezone; this pins the server half that must never be unlabeled.
describe("LocalTime server render", () => {
  it("renders the instant in UTC with the zone named, inside <time dateTime>", () => {
    const html = renderToStaticMarkup(
      createElement(LocalTime, { iso: "2026-11-15T17:26:00.000Z" }),
    );

    expect(html).toContain('dateTime="2026-11-15T17:26:00.000Z"');
    expect(html).toContain(">2026-11-15 17:26 UTC</time>");
  });

  it("renders a missing instant as —, never a date", () => {
    expect(renderToStaticMarkup(createElement(LocalTime, { iso: null }))).toBe(
      "<span>—</span>",
    );
  });
});
