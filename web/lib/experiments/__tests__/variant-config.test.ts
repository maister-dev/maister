import { describe, expect, it } from "vitest";

import { MaisterError } from "@/lib/errors-core";
import {
  applyCapabilityOverlay,
  assertOverlayRefsKnown,
  assertVariantOverlaySupported,
  experimentVariantConfigSchema,
} from "@/lib/experiments/variant-config";

describe("experiment variant config", () => {
  it("rejects unknown variant config keys", () => {
    expect(() =>
      experimentVariantConfigSchema.parse({
        capabilityOverlay: { skills: { add: ["skill-a"] } },
        unexpected: true,
      }),
    ).toThrow();
  });

  it("rejects the same overlay ref in add and remove", () => {
    expect(() =>
      experimentVariantConfigSchema.parse({
        capabilityOverlay: {
          skills: { add: ["aif-implement"], remove: ["aif-implement"] },
        },
      }),
    ).toThrow();
  });

  it("applies removals before additions for stable capability selections", () => {
    expect(
      applyCapabilityOverlay(
        {
          selectedMcpIds: ["github"],
          selectedSkillIds: ["base-skill", "remove-me"],
          selectedRuleIds: ["base-rule"],
          selectedAgentDefinitionIds: [],
        },
        {
          skills: { remove: ["remove-me"], add: ["added-skill"] },
          rules: { add: ["rule-b"] },
        },
      ),
    ).toEqual({
      selectedMcpIds: ["github"],
      selectedSkillIds: ["base-skill", "added-skill"],
      selectedRuleIds: ["base-rule", "rule-b"],
      selectedAgentDefinitionIds: [],
    });
  });

  it("refuses a vanished overlay ref with CONFIG naming the ref", () => {
    expect(() =>
      assertOverlayRefsKnown(
        { mcps: { add: ["missing-mcp"] } },
        {
          rules: new Set(),
          skills: new Set(),
          mcps: new Set(["github"]),
          subagents: new Set(),
        },
      ),
    ).toThrowError(
      new MaisterError("CONFIG", 'unknown mcps overlay ref "missing-mcp"'),
    );
  });

  it("refuses subagent overlays for non-Claude agents before side effects", () => {
    expect(() =>
      assertVariantOverlaySupported({
        capabilityAgent: "codex",
        variantKey: "codex",
        overlay: { subagents: { add: ["reviewer"] } },
      }),
    ).toThrowError(
      new MaisterError(
        "CONFIG",
        'variant "codex" overlay "subagents" is not supported by codex',
      ),
    );
  });

  it("allows an empty overlay without changing baseline selections", () => {
    expect(
      applyCapabilityOverlay(
        {
          selectedMcpIds: ["github"],
          selectedSkillIds: ["aif-implement"],
          selectedRuleIds: [],
          selectedAgentDefinitionIds: [],
        },
        {},
      ),
    ).toEqual({
      selectedMcpIds: ["github"],
      selectedSkillIds: ["aif-implement"],
      selectedRuleIds: [],
      selectedAgentDefinitionIds: [],
    });
  });
});
