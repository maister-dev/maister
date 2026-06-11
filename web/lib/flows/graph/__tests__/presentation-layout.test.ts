import { describe, expect, it } from "vitest";

import { flowYamlV1Schema } from "@/lib/config.schema";
import { presentationLayout } from "@/lib/flows/graph/presentation-layout";

describe("presentationLayout", () => {
  it("projects nodes that declare both coordinates, carrying width/height/color (T2.4)", () => {
    const manifest = flowYamlV1Schema.parse({
      schemaVersion: 1,
      name: "demo",
      nodes: [
        { id: "plan", type: "ai_coding", action: { prompt: "go" } },
        { id: "review", type: "human" },
      ],
      presentation: {
        nodes: [
          { id: "plan", x: 10, y: 20 },
          {
            id: "review",
            x: 200,
            y: 20,
            width: 120,
            height: 90,
            color: "accent",
          },
        ],
      },
    });

    expect(presentationLayout(manifest)).toEqual({
      plan: { x: 10, y: 20 },
      review: { x: 200, y: 20, width: 120, height: 90, color: "accent" },
    });
  });

  it("skips entries missing x or y (dagre seeds those at render)", () => {
    const manifest = flowYamlV1Schema.parse({
      schemaVersion: 1,
      name: "demo",
      nodes: [{ id: "plan", type: "ai_coding", action: { prompt: "go" } }],
      presentation: {
        nodes: [
          { id: "plan", x: 10 },
          { id: "review", color: "danger" },
        ],
      },
    });

    expect(presentationLayout(manifest)).toEqual({});
  });

  it("returns an empty map when no presentation section is authored", () => {
    const manifest = flowYamlV1Schema.parse({
      schemaVersion: 1,
      name: "demo",
      nodes: [{ id: "plan", type: "ai_coding", action: { prompt: "go" } }],
    });

    expect(presentationLayout(manifest)).toEqual({});
  });

  it("accepts the presentation section as additive — a flow without it stays valid", () => {
    const parsed = flowYamlV1Schema.safeParse({
      schemaVersion: 1,
      name: "demo",
      nodes: [{ id: "plan", type: "ai_coding", action: { prompt: "go" } }],
    });

    expect(parsed.success).toBe(true);
  });
});
