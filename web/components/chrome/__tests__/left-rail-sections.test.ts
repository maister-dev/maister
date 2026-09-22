import { describe, expect, it } from "vitest";

import { buildLeftRailSections } from "@/components/chrome/left-rail-sections";

const label = (key: string): string => key;

// The order is ADR-172 D4's, not an accident of insertion: Home / Projects /
// Work / Activity / Inbox / Flow Studio / Observatory, then the admin tail.
describe("buildLeftRailSections", () => {
  it("projects every member-permitted section, including Observatory", () => {
    expect(
      buildLeftRailSections(label, "member").map((section) => section.id),
    ).toEqual([
      "home",
      "projects",
      "work",
      "activity",
      "inbox",
      "studio",
      "observatory",
    ]);
  });

  it("points Projects at the portfolio and Home at the Desk", () => {
    const byId = new Map(
      buildLeftRailSections(label, "member").map((s) => [s.id, s.href]),
    );

    // ADR-172 D3: the rail's "Projects" meant the portfolio all along, and the
    // portfolio is `/projects` now.
    expect(byId.get("home")).toBe("/");
    expect(byId.get("projects")).toBe("/projects");
  });

  it("adds only the existing admin-permitted destinations for an admin", () => {
    expect(
      buildLeftRailSections(label, "admin").map((section) => section.id),
    ).toEqual([
      "home",
      "projects",
      "work",
      "activity",
      "inbox",
      "studio",
      "observatory",
      "agents",
      "mcps",
      "users",
      "executionHost",
      "scheduler",
      "settings",
    ]);
  });
});
