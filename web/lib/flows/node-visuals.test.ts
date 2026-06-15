import { describe, expect, it } from "vitest";

import { GATE_KINDS, NODE_TYPES } from "@/lib/flows/editor/node-form";
import { gateVisual, nodeVisual } from "@/lib/flows/node-visuals";

describe("nodeVisual", () => {
  it("maps every NodeType to a stable icon + forest token", () => {
    const expected: Record<string, { iconName: string; colorToken: string }> = {
      ai_coding: { iconName: "bot", colorToken: "accent-3" },
      judge: { iconName: "gavel", colorToken: "accent-2" },
      cli: { iconName: "terminal", colorToken: "mute" },
      check: { iconName: "shield", colorToken: "attention" },
      human: { iconName: "person", colorToken: "amber" },
    };

    for (const type of NODE_TYPES) {
      expect(nodeVisual(type)).toEqual(expected[type]);
    }
  });

  it("is exhaustive over NODE_TYPES (no type falls through to the default)", () => {
    for (const type of NODE_TYPES) {
      expect(nodeVisual(type).iconName).not.toBe("dot");
    }
  });

  it("falls back to a neutral dot for an unknown/absent type", () => {
    expect(nodeVisual("other")).toEqual({
      iconName: "dot",
      colorToken: "mute",
    });
    expect(nodeVisual("")).toEqual({ iconName: "dot", colorToken: "mute" });
  });
});

describe("gateVisual", () => {
  it("maps every GateKind to a stable icon + forest token", () => {
    const expected: Record<string, { iconName: string; colorToken: string }> = {
      command_check: { iconName: "terminal", colorToken: "mute" },
      skill_check: { iconName: "puzzle", colorToken: "good" },
      ai_judgment: { iconName: "gavel", colorToken: "accent-2" },
      artifact_required: { iconName: "file", colorToken: "accent-3" },
      external_check: { iconName: "link", colorToken: "accent-4" },
      human_review: { iconName: "person", colorToken: "amber" },
    };

    for (const kind of GATE_KINDS) {
      expect(gateVisual(kind)).toEqual(expected[kind]);
    }
  });

  it("is exhaustive over GATE_KINDS (no kind falls through to the default)", () => {
    for (const kind of GATE_KINDS) {
      expect(gateVisual(kind).iconName).not.toBe("dot");
    }
  });

  it("falls back to a neutral dot for an unknown kind", () => {
    expect(gateVisual("nope")).toEqual({ iconName: "dot", colorToken: "mute" });
  });
});
