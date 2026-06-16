import { describe, expect, it } from "vitest";

import {
  capabilityAgentSupported,
  skillCatalogEntry,
  subagentCatalogEntry,
} from "@/lib/capabilities/project-catalog";

describe("skillCatalogEntry — surface forms + support (FR-B2/B3)", () => {
  const skill = {
    refId: "aif-plan",
    label: "AIF Plan",
    agents: ["claude", "codex"] as const,
    material: { description: "Plan a feature", argHint: "<feature>" },
  };

  it("computes the claude wire form /slug with description + argHint", () => {
    expect(skillCatalogEntry(skill, "claude")).toMatchObject({
      kind: "skill",
      refId: "aif-plan",
      slug: "aif-plan",
      displayName: "AIF Plan",
      description: "Plan a feature",
      argHint: "<feature>",
      canonicalToken: "@skill:aif-plan",
      surfaceForm: "/aif-plan",
      supported: true,
    });
  });

  it("flips ONLY the surface form on codex ($slug), same canonical token", () => {
    const e = skillCatalogEntry(skill, "codex");

    expect(e.surfaceForm).toBe("$aif-plan");
    expect(e.canonicalToken).toBe("@skill:aif-plan");
    expect(e.supported).toBe(true);
  });

  it("marks supported=false when the agents mask excludes the runner", () => {
    expect(
      skillCatalogEntry({ ...skill, agents: ["claude"] }, "codex").supported,
    ).toBe(false);
  });

  it("returns null description/argHint when material lacks them", () => {
    const e = skillCatalogEntry(
      { refId: "x", label: "X", agents: ["claude"], material: {} },
      "claude",
    );

    expect(e.description).toBeNull();
    expect(e.argHint).toBeNull();
  });
});

describe("subagentCatalogEntry — @name, claude-only (FR-B3)", () => {
  it("builds an @name subagent entry", () => {
    expect(
      subagentCatalogEntry({
        refId: "pkg:reviewer",
        slug: "reviewer",
        displayName: "Reviewer",
        description: "Reviews code",
      }),
    ).toMatchObject({
      kind: "subagent",
      refId: "pkg:reviewer",
      slug: "reviewer",
      displayName: "Reviewer",
      description: "Reviews code",
      argHint: null,
      canonicalToken: "@agent:reviewer",
      surfaceForm: "@reviewer",
      supported: true,
    });
  });
});

describe("capabilityAgentSupported", () => {
  it("array form: includes check", () => {
    expect(capabilityAgentSupported(["claude"], "claude")).toBe(true);
    expect(capabilityAgentSupported(["claude"], "codex")).toBe(false);
  });

  it("record form: key presence", () => {
    expect(capabilityAgentSupported({ claude: "ok" }, "claude")).toBe(true);
    expect(capabilityAgentSupported({ claude: "ok" }, "codex")).toBe(false);
  });

  it("nullish mask → supported (no restriction)", () => {
    expect(capabilityAgentSupported(null, "codex")).toBe(true);
    expect(capabilityAgentSupported(undefined, "mimo")).toBe(true);
  });
});
