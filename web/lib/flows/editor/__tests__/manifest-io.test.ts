import type { NodePresentation } from "@/lib/flows/editor/manifest-io";

import { describe, expect, it } from "vitest";

import { flowYamlV1Schema } from "@/lib/config.schema";
import {
  applyPresentation,
  readPresentation,
} from "@/lib/flows/editor/manifest-io";

// A small graph-form manifest fixture with two nodes.
const BASE_MANIFEST = flowYamlV1Schema.parse({
  schemaVersion: 1,
  name: "Test Flow",
  nodes: [
    { id: "plan", type: "ai_coding", action: { prompt: "plan it" } },
    { id: "review", type: "human" },
  ],
});

describe("applyPresentation + readPresentation (round-trip)", () => {
  it("round-trips a layout with x, y, width, height, color for known ids", () => {
    const layout: NodePresentation[] = [
      { id: "plan", x: 10, y: 20, width: 200, height: 80, color: "accent" },
      { id: "review", x: 300, y: 20 },
    ];

    const result = readPresentation(applyPresentation(BASE_MANIFEST, layout));

    expect(result).toEqual(
      expect.arrayContaining([
        { id: "plan", x: 10, y: 20, width: 200, height: 80, color: "accent" },
        { id: "review", x: 300, y: 20 },
      ]),
    );
    expect(result).toHaveLength(2);
  });
});

describe("readPresentation", () => {
  it("returns empty array when presentation section is absent", () => {
    expect(readPresentation(BASE_MANIFEST)).toEqual([]);
  });

  it("returns the nodes array from the presentation section", () => {
    const manifest = flowYamlV1Schema.parse({
      schemaVersion: 1,
      name: "demo",
      nodes: [
        { id: "plan", type: "ai_coding", action: { prompt: "go" } },
        { id: "review", type: "human" },
      ],
      presentation: {
        nodes: [
          { id: "plan", x: 5, y: 15 },
          {
            id: "review",
            x: 100,
            y: 200,
            width: 120,
            height: 60,
            color: "red",
          },
        ],
      },
    });

    expect(readPresentation(manifest)).toEqual([
      { id: "plan", x: 5, y: 15 },
      { id: "review", x: 100, y: 200, width: 120, height: 60, color: "red" },
    ]);
  });
});

describe("applyPresentation", () => {
  it("drops presentations for ids absent from manifest.nodes[]", () => {
    const layout: NodePresentation[] = [
      { id: "plan", x: 10, y: 20 },
      { id: "ghost", x: 99, y: 99 }, // not in manifest
    ];

    const result = applyPresentation(BASE_MANIFEST, layout);
    const nodes = result.presentation?.nodes ?? [];

    expect(nodes.map((n) => n.id)).toEqual(["plan"]);
  });

  it("preserves logic fields (name, nodes, compat) unchanged", () => {
    const layout: NodePresentation[] = [{ id: "plan", x: 1, y: 2 }];
    const result = applyPresentation(BASE_MANIFEST, layout);

    expect(result.name).toBe(BASE_MANIFEST.name);
    expect(result.nodes).toEqual(BASE_MANIFEST.nodes);
    expect(result.schemaVersion).toBe(1);
  });

  it("preserves extension fields while applying presentation", () => {
    const manifest = flowYamlV1Schema.parse({
      schemaVersion: 1,
      name: "extensions",
      "x-flow-extension": { owner: "designer" },
      nodes: [
        {
          id: "plan",
          type: "ai_coding",
          action: { prompt: "go" },
          "x-node-extension": { lane: "custom" },
        },
      ],
    });

    const result = applyPresentation(manifest, [{ id: "plan", x: 1, y: 2 }]);

    expect(result).toMatchObject({
      "x-flow-extension": { owner: "designer" },
      nodes: [{ "x-node-extension": { lane: "custom" } }],
    });
  });

  it("does not mutate the input manifest", () => {
    const original = flowYamlV1Schema.parse({
      schemaVersion: 1,
      name: "immutable",
      nodes: [{ id: "plan", type: "ai_coding", action: { prompt: "go" } }],
    });
    const before = JSON.stringify(original);

    applyPresentation(original, [{ id: "plan", x: 0, y: 0 }]);

    expect(JSON.stringify(original)).toBe(before);
  });

  it("produces a manifest with presentation absent (or empty nodes) when layout is empty", () => {
    const result = applyPresentation(BASE_MANIFEST, []);
    const nodes = result.presentation?.nodes ?? [];

    expect(nodes).toHaveLength(0);
  });

  it("round-trips optional width, height, color fields", () => {
    const layout: NodePresentation[] = [
      { id: "plan", x: 0, y: 0, width: 150, height: 70, color: "blue" },
    ];

    const readBack = readPresentation(applyPresentation(BASE_MANIFEST, layout));

    expect(readBack).toEqual([
      { id: "plan", x: 0, y: 0, width: 150, height: 70, color: "blue" },
    ]);
  });

  it("validates against flowPresentationSchema and accepts well-formed input", () => {
    // If schema validation threw, this call would throw — assert it doesn't.
    expect(() =>
      applyPresentation(BASE_MANIFEST, [
        { id: "plan", x: 10, y: 20, width: 200, height: 80 },
      ]),
    ).not.toThrow();
  });

  // steps[]-form manifests: node-id integrity should also work with steps[].
  it("drops presentations for ids absent from manifest.steps[]", () => {
    const stepsManifest = flowYamlV1Schema.parse({
      schemaVersion: 1,
      name: "steps flow",
      steps: [
        {
          id: "step1",
          type: "agent",
          mode: "new-session",
          prompt: "do something",
        },
      ],
    });

    const result = applyPresentation(stepsManifest, [
      { id: "step1", x: 0, y: 0 },
      { id: "unknown", x: 1, y: 1 },
    ]);
    const ids = (result.presentation?.nodes ?? []).map((n) => n.id);

    expect(ids).toEqual(["step1"]);
  });
});
