import { describe, expect, it } from "vitest";

import { parseExportAuthoredFlowArgs } from "../../../scripts/export-authored-flow";
import { parseImportFlowPackageDraftArgs } from "../../../scripts/import-flow-package-draft";
import { parseInstallAuthoredFlowPackageArgs } from "../../../scripts/install-authored-flow-package";
import { parseValidateAuthoredFlowArgs } from "../../../scripts/validate-authored-flow";

describe("authored Flow package CLI args", () => {
  it("requires validate --source-dir (no default since the aif extraction)", () => {
    expect(() => parseValidateAuthoredFlowArgs([])).toThrow(
      /Missing required --source-dir/,
    );
    expect(
      parseValidateAuthoredFlowArgs(["--source-dir", "test-fixtures/aif-flows/dev"]),
    ).toEqual({ sourceDir: "test-fixtures/aif-flows/dev" });
  });

  it("parses import draft args with optional overrides", () => {
    expect(
      parseImportFlowPackageDraftArgs([
        "--project",
        "demo",
        "--source-dir",
        "test-fixtures/aif-flows/dev",
        "--slug",
        "aif",
        "--title",
        "AI Factory",
      ]),
    ).toEqual({
      project: "demo",
      sourceDir: "test-fixtures/aif-flows/dev",
      slug: "aif",
      title: "AI Factory",
    });
  });

  it("requires import project", () => {
    expect(() => parseImportFlowPackageDraftArgs([])).toThrow(
      /Missing required --project/,
    );
  });

  it("rejects unsafe import draft slug overrides", () => {
    expect(() =>
      parseImportFlowPackageDraftArgs([
        "--project",
        "demo",
        "--source-dir",
        "test-fixtures/aif-flows/dev",
        "--slug",
        "aif\nnodes: []",
      ]),
    ).toThrow(/invalid authored Flow package slug/);
  });

  it("parses export by capability id", () => {
    expect(
      parseExportAuthoredFlowArgs([
        "--project",
        "demo",
        "--cap-id",
        "cap-1",
        "--output-dir",
        "/tmp/aif",
      ]),
    ).toEqual({
      project: "demo",
      capId: "cap-1",
      outputDir: "/tmp/aif",
      slug: undefined,
    });
  });

  it("parses export by package slug", () => {
    expect(
      parseExportAuthoredFlowArgs([
        "--project",
        "demo",
        "--slug",
        "aif",
        "--output-dir",
        "/tmp/aif",
      ]),
    ).toEqual({
      project: "demo",
      capId: undefined,
      outputDir: "/tmp/aif",
      slug: "aif",
    });
  });

  it("requires exactly one export identifier", () => {
    expect(() =>
      parseExportAuthoredFlowArgs([
        "--project",
        "demo",
        "--output-dir",
        "/tmp/aif",
      ]),
    ).toThrow(/exactly one/);
  });

  it("parses authored bridge install args", () => {
    expect(
      parseInstallAuthoredFlowPackageArgs([
        "--project",
        "demo",
        "--source-dir",
        "/tmp/aif",
        "--version",
        "authored-aif",
        "--flow-id",
        "aif",
      ]),
    ).toEqual({
      project: "demo",
      sourceDir: "/tmp/aif",
      version: "authored-aif",
      flowId: "aif",
      workspaceRoot: undefined,
    });
  });

  it("requires bridge install source dir", () => {
    expect(() =>
      parseInstallAuthoredFlowPackageArgs([
        "--project",
        "demo",
        "--version",
        "authored-aif",
        "--flow-id",
        "aif",
      ]),
    ).toThrow(/Missing required --source-dir/);
  });
});
