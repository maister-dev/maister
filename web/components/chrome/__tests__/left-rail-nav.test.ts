import type { RailSectionId } from "@/components/chrome/left-rail-route";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  LeftRailNavView,
  type LeftRailNavSection,
} from "@/components/chrome/left-rail-nav";
import { railSectionForPathname } from "@/components/chrome/left-rail-route";

const sections: LeftRailNavSection[] = [
  { id: "projects", label: "Projects", href: "/", ready: true },
  { id: "inbox", label: "Inbox", href: "/inbox", ready: true },
  { id: "studio", label: "Studio", href: "/studio", ready: true },
  { id: "mcps", label: "MCPs", href: "/mcps", ready: true },
  { id: "users", label: "Users", href: "/admin/users", ready: true },
  { id: "scheduler", label: "Scheduler", href: "/admin/scheduler", ready: true },
  { id: "settings", label: "Settings", href: "/settings", ready: true },
];

function renderActive(activeSection: RailSectionId | null): string {
  return renderToStaticMarkup(
    createElement(LeftRailNavView, {
      activeSection,
      comingSoon: "Coming soon",
      inboxCount: 0,
      sections,
      variant: "expanded",
    }),
  );
}

function linkTag(html: string, id: RailSectionId): string {
  const match = html.match(
    new RegExp(`<a[^>]*data-testid="rail-nav-${id}"[^>]*>`),
  );

  expect(match?.[0]).toBeTruthy();

  return match?.[0] ?? "";
}

describe("LeftRail navigation", () => {
  it("maps app routes to their rail section", () => {
    expect(railSectionForPathname("/")).toBe("projects");
    expect(railSectionForPathname("/projects/acme/tasks/7")).toBe("projects");
    expect(railSectionForPathname("/runs/run-1")).toBe("projects");
    expect(railSectionForPathname("/inbox")).toBe("inbox");
    expect(railSectionForPathname("/studio/packages")).toBe("studio");
    expect(railSectionForPathname("/flows/new")).toBe("studio");
    expect(railSectionForPathname("/mcps")).toBe("mcps");
    expect(railSectionForPathname("/admin/users")).toBe("users");
    expect(railSectionForPathname("/admin/scheduler")).toBe("scheduler");
    expect(railSectionForPathname("/settings")).toBe("settings");
  });

  it("marks settings active without keeping projects selected", () => {
    const html = renderActive("settings");

    expect(linkTag(html, "settings")).toContain('aria-current="page"');
    expect(linkTag(html, "projects")).not.toContain('aria-current="page"');
  });
});
