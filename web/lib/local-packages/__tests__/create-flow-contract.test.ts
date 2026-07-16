import { describe, expect, it } from "vitest";

import { flowYamlV1Schema } from "@/lib/config.schema";
import {
  buildStarterFlowManifest,
  createFlowInputSchema,
  createLocalPackageWithFlowSchema,
} from "@/lib/local-packages/create-flow-contract";

const FLOW = {
  id: "bugfix",
  metadata: {
    title: "Fix a bug",
    summary: "Diagnose and repair a reproducible defect.",
    route_when: "A bug report includes clear reproduction steps.",
    labels: ["maintenance", "bug"],
    links: [
      { kind: "docs", title: "Triage", url: "https://example.test/triage" },
    ],
    sources: [{ component: "web", origin: "repository" }],
  },
};

describe("canonical create-flow contract", () => {
  it("requires the package and complete required Flow metadata for a first Flow", () => {
    expect(
      createLocalPackageWithFlowSchema.safeParse({ name: "Bug fixes", flow: FLOW })
        .success,
    ).toBe(true);
    expect(
      createLocalPackageWithFlowSchema.safeParse({
        name: "Bug fixes",
        flow: { ...FLOW, metadata: { ...FLOW.metadata, route_when: "" } },
      }).success,
    ).toBe(false);
  });

  it("rejects an unsafe or traversal-shaped Flow ID before it can become a path", () => {
    expect(createFlowInputSchema.safeParse({ ...FLOW, id: "../escape" }).success).toBe(false);
    expect(createFlowInputSchema.safeParse({ ...FLOW, id: "has spaces" }).success).toBe(false);
  });

  it("builds a valid graph-only starter manifest with explicit safe defaults", () => {
    const manifest = buildStarterFlowManifest(FLOW);
    const parsed = flowYamlV1Schema.safeParse(manifest);

    expect(parsed.success).toBe(true);
    expect(manifest.name).toBe("bugfix");
    expect(manifest.metadata.title).toBe("Fix a bug");
    expect(manifest.compat.engine_min).toBe("3.0.0");
    expect(manifest.capabilities).toEqual([]);
    expect(manifest.artifacts).toEqual([]);
    expect(manifest.nodes).toEqual([
      expect.objectContaining({ id: "start", transitions: { success: "done" } }),
    ]);
  });
});
