import { describe, expect, it } from "vitest";

import { GATE_KINDS, NODE_TYPES } from "@/lib/flows/editor/node-form";
import { gateVisual, nodeVisual } from "@/lib/flows/node-visuals";

describe("nodeVisual", () => {
  it("maps every NodeType to a stable icon + forest token", () => {
    const expected: Record<string, { iconName: string; colorToken: string }> = {
      ai_coding: { iconName: "bot", colorToken: "cv-green" },
      orchestrator: { iconName: "sitemap", colorToken: "cv-teal" },
      judge: { iconName: "gavel", colorToken: "cv-violet" },
      consensus: { iconName: "network", colorToken: "cv-teal" },
      cli: { iconName: "terminal", colorToken: "cv-gray" },
      check: { iconName: "shield", colorToken: "cv-amber" },
      human: { iconName: "person", colorToken: "cv-blue" },
      form: { iconName: "form", colorToken: "cv-rose" },
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
      colorToken: "cv-gray",
    });
    expect(nodeVisual("")).toEqual({ iconName: "dot", colorToken: "cv-gray" });
  });
});

describe("gateVisual", () => {
  it("maps every GateKind to a stable icon + forest token", () => {
    const expected: Record<string, { iconName: string; colorToken: string }> = {
      command_check: { iconName: "terminal", colorToken: "cv-gray" },
      skill_check: { iconName: "puzzle", colorToken: "cv-teal" },
      ai_judgment: { iconName: "gavel", colorToken: "cv-violet" },
      artifact_required: { iconName: "file", colorToken: "cv-amber" },
      external_check: { iconName: "link", colorToken: "cv-blue" },
      human_review: { iconName: "person", colorToken: "cv-rose" },
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
    expect(gateVisual("nope")).toEqual({
      iconName: "dot",
      colorToken: "cv-gray",
    });
  });
});
