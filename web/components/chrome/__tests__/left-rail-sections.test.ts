import { describe, expect, it } from "vitest";

import { buildLeftRailSections } from "@/components/chrome/left-rail-sections";

const label = (key: string): string => key;

describe("buildLeftRailSections", () => {
  it("projects every member-permitted section, including Observatory", () => {
    expect(
      buildLeftRailSections(label, "member").map((section) => section.id),
    ).toEqual(["projects", "inbox", "studio", "observatory"]);
  });

  it("adds only the existing admin-permitted destinations for an admin", () => {
    expect(
      buildLeftRailSections(label, "admin").map((section) => section.id),
    ).toEqual([
      "projects",
      "inbox",
      "studio",
      "observatory",
      "agents",
      "mcps",
      "users",
      "scheduler",
      "settings",
    ]);
  });
});
