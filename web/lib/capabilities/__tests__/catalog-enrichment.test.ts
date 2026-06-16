import { describe, expect, it } from "vitest";

import { capabilityInputsFromConfig } from "@/lib/capabilities/catalog";

// FR-B1: the install projection parses SKILL.md frontmatter and stores
// `description` + `argument-hint` (→ `argHint`) into capability_records.material
// (no migration; material is rebuilt wholesale each upsert → SET/CLEAR symmetry).

function configWithSkill(content?: string): any {
  return {
    mcps: [],
    skills: [
      {
        id: "aif-plan",
        kind: "skill",
        source: "flow-package",
        agents: ["claude", "codex"],
        enforceability: "instructed",
        selected_by_default: true,
        content,
      },
    ],
    rules: [],
    restrictions: [],
    settings: [],
    tools: [],
    agent_definitions: [],
    env_profiles: [],
  };
}

function skillMaterial(content?: string): Record<string, unknown> {
  const record = capabilityInputsFromConfig(configWithSkill(content)).find(
    (r) => r.kind === "skill",
  );

  return (record?.material ?? {}) as Record<string, unknown>;
}

describe("capabilityInputsFromConfig — skill frontmatter enrichment (FR-B1)", () => {
  it("captures description + argHint from SKILL.md frontmatter into material", () => {
    const material = skillMaterial(
      "---\nname: aif-plan\ndescription: Plan a feature\nargument-hint: <feature>\n---\nBody text",
    );

    expect(material).toMatchObject({
      description: "Plan a feature",
      argHint: "<feature>",
    });
  });

  it("captures description but omits argHint when frontmatter has no argument-hint (CLEAR symmetry)", () => {
    const material = skillMaterial(
      "---\nname: aif-plan\ndescription: only desc\n---\nBody",
    );

    expect(material.description).toBe("only desc");
    expect(material.argHint).toBeUndefined();
  });

  it("captures neither when the skill has no content", () => {
    const material = skillMaterial(undefined);

    expect(material.description).toBeUndefined();
    expect(material.argHint).toBeUndefined();
  });

  it("is idempotent — re-running yields identical material", () => {
    const content = "---\nname: x\ndescription: D\nargument-hint: H\n---\nBody";

    expect(skillMaterial(content)).toEqual(skillMaterial(content));
  });
});
