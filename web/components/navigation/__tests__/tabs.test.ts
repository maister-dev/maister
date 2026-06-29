// Unit contract for the shared Tabs segmented control (style A). Uses
// renderToStaticMarkup (no jsdom): next/link renders as <a>, buttons render with
// role/aria but no onClick — enough to pin the rendered contract for both the
// URL-driven (href) and state-driven (onSelect) modes.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Tabs, type TabItem } from "@/components/navigation/tabs";

const LINK_ITEMS: TabItem[] = [
  { key: "a", label: "Alpha", href: "/x?tab=a" },
  { key: "b", label: "Beta", href: "/x?tab=b", count: 3 },
];

function render(props: Parameters<typeof Tabs>[0]): string {
  return renderToStaticMarkup(createElement(Tabs, props));
}

describe("Tabs", () => {
  it("renders a tablist with one role='tab' per item", () => {
    const html = render({ items: LINK_ITEMS, activeKey: "a" });

    expect(html.split('role="tab"').length - 1).toBe(2);
    expect(html).toContain('role="tablist"');
  });

  it("renders href tabs as links", () => {
    const html = render({ items: LINK_ITEMS, activeKey: "a" });

    expect(html).toContain('href="/x?tab=a"');
    expect(html).toContain('href="/x?tab=b"');
  });

  it("marks exactly the active tab aria-selected", () => {
    const html = render({ items: LINK_ITEMS, activeKey: "b" });

    expect(html.split('aria-selected="true"').length - 1).toBe(1);
    expect(html).toMatch(
      /href="\/x\?tab=b"[^>]*aria-selected="true"|aria-selected="true"[^>]*href="\/x\?tab=b"/,
    );
  });

  it("renders an optional count badge", () => {
    const html = render({ items: LINK_ITEMS, activeKey: "a" });

    expect(html).toContain("3");
  });

  it("renders button tabs when no href is provided", () => {
    const html = render({
      items: [
        { key: "a", label: "Alpha" },
        { key: "b", label: "Beta" },
      ],
      activeKey: "a",
      onSelect: () => {},
    });

    expect(html.split("<button").length - 1).toBe(2);
    expect(html).not.toContain("<a ");
  });

  it("passes through a per-item testId", () => {
    const html = render({
      items: [{ key: "a", label: "Alpha", href: "/x", testId: "my-tab-a" }],
      activeKey: "a",
    });

    expect(html).toContain('data-testid="my-tab-a"');
  });

  it("applies the aria-label to the tablist", () => {
    const html = render({
      items: LINK_ITEMS,
      activeKey: "a",
      ariaLabel: "Sections",
    });

    expect(html).toContain('aria-label="Sections"');
  });

  it("renders a leading icon when provided", () => {
    const html = render({
      items: [
        {
          key: "a",
          label: "Alpha",
          icon: createElement("svg", { "data-testid": "tab-icon" }),
        },
      ],
      activeKey: "a",
      onSelect: () => {},
    });

    expect(html).toContain('data-testid="tab-icon"');
  });
});
