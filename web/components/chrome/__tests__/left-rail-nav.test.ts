import type { RailSectionId } from "@/components/chrome/left-rail-route";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  LeftRailNavView,
  type LeftRailNavSection,
  type RailBadges,
} from "@/components/chrome/left-rail-nav";
import { railSectionForPathname } from "@/components/chrome/left-rail-route";

const sections: LeftRailNavSection[] = [
  { id: "home", label: "Home", href: "/", ready: true },
  { id: "projects", label: "Projects", href: "/projects", ready: true },
  { id: "activity", label: "Activity", href: "/activity", ready: true },
  { id: "inbox", label: "Inbox", href: "/inbox", ready: true },
  { id: "studio", label: "Studio", href: "/studio", ready: true },
  { id: "mcps", label: "MCPs", href: "/mcps", ready: true },
  { id: "users", label: "Users", href: "/admin/users", ready: true },
  {
    id: "scheduler",
    label: "Scheduler",
    href: "/admin/scheduler",
    ready: true,
  },
  { id: "settings", label: "Settings", href: "/settings", ready: true },
];

function renderActive(
  activeSection: RailSectionId | null,
  badges: RailBadges = {},
  variant: "collapsed" | "expanded" = "expanded",
): string {
  return renderToStaticMarkup(
    createElement(LeftRailNavView, {
      activeSection,
      ariaLabel: "Sections",
      badges,
      comingSoon: "Coming soon",
      sections,
      variant,
    }),
  );
}

// ADR-169 D7 / `ATN-05`: both numbers come from ONE layout-level fetch and are
// passed down; the rail never computes either.
const BOTH_BADGES: RailBadges = {
  inbox: { value: 3, tone: "attention", label: "3 blocked on you" },
  activity: { value: 12, tone: "neutral", label: "12 unseen" },
};

function badgeTag(html: string, testid: string): string {
  const match = html.match(
    new RegExp(`<span[^>]*data-testid="${testid}"[^>]*>`),
  );

  expect(match?.[0], `badge ${testid}`).toBeTruthy();

  return match?.[0] ?? "";
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
    // `UT-NAV-04` owns the full prefix table; this keeps the rail's own view of
    // it honest.
    expect(railSectionForPathname("/")).toBe("home");
    expect(railSectionForPathname("/projects/acme/tasks/7")).toBe("projects");
    expect(railSectionForPathname("/runs/run-1")).toBe("projects");
    expect(railSectionForPathname("/inbox")).toBe("inbox");
    expect(railSectionForPathname("/activity")).toBe("activity");
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
    expect(linkTag(html, "home")).not.toContain('aria-current="page"');
  });

  it("marks Home active on the Desk without also marking Projects", () => {
    const html = renderActive("home");

    expect(linkTag(html, "home")).toContain('aria-current="page"');
    expect(linkTag(html, "projects")).not.toContain('aria-current="page"');
  });

  it("uses packaged Heroicons for rail section icons", () => {
    const html = renderActive("settings");

    for (const section of sections) {
      expect(html).toContain(`data-testid="rail-icon-${section.id}"`);
    }

    expect(html).toContain('viewBox="0 0 24 24"');
    expect(html).not.toContain("M6.9 1.7h2.2");
  });
});

// T5.7 (ADR-169 D7). The two counters are separate populations, and the tone is
// the only thing telling a reader which one demands action. A neutral badge
// wearing the attention colour would make "12 things happened" read as
// "12 things need you" — the exact confusion this milestone exists to remove.
describe("rail badges", () => {
  it("renders both badges from one passed-down source", () => {
    const html = renderActive(null, BOTH_BADGES);

    expect(badgeTag(html, "inbox-nav-badge")).toBeTruthy();
    expect(badgeTag(html, "activity-nav-badge")).toBeTruthy();
    expect(html).toContain(">3<");
    expect(html).toContain(">12<");
  });

  it("gives the two badges distinct tones", () => {
    const html = renderActive(null, BOTH_BADGES);
    const decisions = badgeTag(html, "inbox-nav-badge");
    const updates = badgeTag(html, "activity-nav-badge");

    expect(decisions).toContain("bg-amber");
    expect(decisions).not.toBe(updates);
  });

  it("keeps every attention style off the neutral badge", () => {
    const updates = badgeTag(
      renderActive(null, BOTH_BADGES),
      "activity-nav-badge",
    );

    for (const attentionClass of ["bg-amber", "text-amber", "border-amber"]) {
      expect(updates).not.toContain(attentionClass);
    }
  });

  it("names each badge for a screen reader instead of leaving a bare digit", () => {
    const html = renderActive(null, BOTH_BADGES);

    expect(html).toContain("3 blocked on you");
    expect(html).toContain("12 unseen");
  });

  it("carries both badges into the collapsed rail as well", () => {
    const html = renderActive(null, BOTH_BADGES, "collapsed");

    expect(badgeTag(html, "inbox-nav-badge-collapsed")).toContain("bg-amber");
    expect(badgeTag(html, "activity-nav-badge-collapsed")).not.toContain(
      "bg-amber",
    );
  });

  it("renders no badge at zero rather than a zero", () => {
    const html = renderActive(null, {
      inbox: { value: 0, tone: "attention", label: "0 blocked on you" },
      activity: { value: 0, tone: "neutral", label: "0 unseen" },
    });

    expect(html).not.toContain("inbox-nav-badge");
    expect(html).not.toContain("activity-nav-badge");
  });

  it("shows one badge without inventing the other", () => {
    const html = renderActive(null, {
      activity: { value: 4, tone: "neutral", label: "4 unseen" },
    });

    expect(html).not.toContain("inbox-nav-badge");
    expect(badgeTag(html, "activity-nav-badge")).toBeTruthy();
  });
});
