import { describe, expect, it } from "vitest";

import { buildLeftRailSections } from "@/components/chrome/left-rail-sections";

const label = (key: string): string => key;

// Native Knowledge (ADR-200) extends the ADR-172 spine after Inbox;
// administrator-only destinations remain in the tail.
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
      "knowledge",
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
      "knowledge",
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
