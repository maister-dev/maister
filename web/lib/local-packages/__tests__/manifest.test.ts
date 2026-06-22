import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

import {
  applyManifestScalars,
  parsePackageManifest,
  validatePackageManifestYaml,
} from "@/lib/local-packages/manifest";

const VALID_MANIFEST = `schemaVersion: 1
name: my-pkg
metadata:
  title: My Package
  summary: Does things
flows:
  - id: bugfix
    path: flows/bugfix
capabilities:
  - id: review
    path: skills/review
`;

describe("parsePackageManifest", () => {
  it("extracts scalar fields + entry summaries from a valid manifest", () => {
    const result = parsePackageManifest(VALID_MANIFEST);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.model.name).toBe("my-pkg");
    expect(result.model.title).toBe("My Package");
    expect(result.model.summary).toBe("Does things");
    expect(result.model.flows).toEqual([
      { id: "bugfix", path: "flows/bugfix" },
    ]);
    expect(result.model.capabilities).toEqual([
      { id: "review", path: "skills/review" },
    ]);
  });

  it("treats an empty file as an empty mapping (fresh package)", () => {
    const result = parsePackageManifest("");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.model.name).toBe("");
    expect(result.model.flows).toEqual([]);
  });

  it("reports an error for a non-mapping document", () => {
    expect(parsePackageManifest("- a\n- b\n").ok).toBe(false);
  });
});

describe("applyManifestScalars", () => {
  it("updates name + metadata and PRESERVES the entry arrays", () => {
    const parsed = parsePackageManifest(VALID_MANIFEST);

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const next = applyManifestScalars(parsed.raw, {
      name: "renamed",
      title: "Renamed",
      summary: "New summary",
    });
    const reparsed = parseYaml(next) as Record<string, unknown>;

    expect(reparsed.name).toBe("renamed");
    expect((reparsed.metadata as Record<string, unknown>).title).toBe(
      "Renamed",
    );
    expect(reparsed.flows).toEqual([{ id: "bugfix", path: "flows/bugfix" }]);
    expect(reparsed.schemaVersion).toBe(1);
  });

  it("drops the metadata block when title + summary are emptied", () => {
    const parsed = parsePackageManifest(VALID_MANIFEST);

    if (!parsed.ok) return;

    const next = applyManifestScalars(parsed.raw, {
      name: "x",
      title: "",
      summary: "",
    });

    expect(
      (parseYaml(next) as Record<string, unknown>).metadata,
    ).toBeUndefined();
  });
});

describe("validatePackageManifestYaml", () => {
  it("returns no issues for a valid manifest", () => {
    expect(validatePackageManifestYaml(VALID_MANIFEST)).toEqual([]);
  });

  it("flags a manifest with zero flows (schema requires >= 1)", () => {
    expect(
      validatePackageManifestYaml("schemaVersion: 1\nname: x\nflows: []\n")
        .length,
    ).toBeGreaterThan(0);
  });

  it("flags unparseable YAML", () => {
    expect(validatePackageManifestYaml(":\n  - bad: [").length).toBeGreaterThan(
      0,
    );
  });
});
