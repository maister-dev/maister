import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

import {
  appendManifestFlow,
  applyManifestScalars,
  parsePackageManifest,
  serializeScaffoldManifest,
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

  it("accepts a manifest with zero flows (empty/draft packages are valid — ADR-105)", () => {
    expect(
      validatePackageManifestYaml("schemaVersion: 1\nname: x\nflows: []\n"),
    ).toEqual([]);
  });

  it("flags unparseable YAML", () => {
    expect(validatePackageManifestYaml(":\n  - bad: [").length).toBeGreaterThan(
      0,
    );
  });
});

describe("serializeScaffoldManifest (F2.a)", () => {
  it("writes a slug-safe name + display title, and validates (display never lands in `name`)", () => {
    const yaml = serializeScaffoldManifest("flow-a-local", "flow-a (local)");
    const parsed = parsePackageManifest(yaml);

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    // The capabilityRefId-shaped slug is the manifest `name`; the display name
    // (spaces/parens — would violate capabilityRefIdSchema) goes to metadata.title.
    expect(parsed.model.name).toBe("flow-a-local");
    expect(parsed.model.title).toBe("flow-a (local)");
    // Empty flows are valid (D2) — a fresh scaffold passes the install schema.
    expect(validatePackageManifestYaml(yaml)).toEqual([]);
  });
});

describe("appendManifestFlow (F2.b)", () => {
  it("adds a flow entry, preserving other fields, and is idempotent on id", () => {
    const base = serializeScaffoldManifest("pkg", "Pkg");

    const once = appendManifestFlow(parseYaml(base), {
      id: "flow-a",
      path: "flows/flow-a",
    });
    const onceParsed = parsePackageManifest(once);

    expect(onceParsed.ok).toBe(true);
    if (!onceParsed.ok) return;
    expect(onceParsed.model.name).toBe("pkg");
    expect(onceParsed.model.flows).toEqual([
      { id: "flow-a", path: "flows/flow-a" },
    ]);
    // A flow already listed is not duplicated.
    const twice = appendManifestFlow(parseYaml(once), {
      id: "flow-a",
      path: "flows/flow-a",
    });
    const twiceParsed = parsePackageManifest(twice);

    expect(twiceParsed.ok).toBe(true);
    if (!twiceParsed.ok) return;
    expect(twiceParsed.model.flows).toHaveLength(1);
  });
});
