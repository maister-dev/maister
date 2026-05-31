import type { FlowYamlV1 } from "@/lib/config.schema";

import { describe, expect, it } from "vitest";

import { manifestDigest } from "@/lib/flows/digest";

const base: FlowYamlV1 = {
  schemaVersion: 1,
  name: "Bugfix",
  steps: [{ id: "plan", type: "agent", mode: "new-session", prompt: "/plan" }],
};

describe("manifestDigest", () => {
  it("is stable across top-level key reordering", () => {
    const a = manifestDigest({ ...base });
    const reordered = {
      steps: base.steps,
      name: base.name,
      schemaVersion: base.schemaVersion,
    } as FlowYamlV1;

    expect(manifestDigest(reordered)).toBe(a);
  });

  it("is stable across nested key reordering", () => {
    const a = manifestDigest({
      ...base,
      compat: { engine_min: "1.0.0", engine_max: "2.0.0" },
    });
    const b = manifestDigest({
      ...base,
      compat: { engine_max: "2.0.0", engine_min: "1.0.0" },
    });

    expect(b).toBe(a);
  });

  it("changes when content changes", () => {
    const a = manifestDigest(base);
    const b = manifestDigest({ ...base, name: "Bugfix v2" });

    expect(b).not.toBe(a);
  });

  it("returns a 64-char hex sha256", () => {
    expect(manifestDigest(base)).toMatch(/^[0-9a-f]{64}$/);
  });
});
