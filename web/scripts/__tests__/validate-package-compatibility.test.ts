import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  parseValidatePackageArgs,
  validatePackageCompatibility,
} from "../validate-package-compatibility";

const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "lib",
  "evaluations",
  "__tests__",
  "fixtures",
);

describe("parseValidatePackageArgs", () => {
  it("parses the release wrapper argv", () => {
    const args = parseValidatePackageArgs([
      "--mode",
      "release",
      "--source",
      "/repo",
      "--tag",
      "core/v1.1.0",
    ]);

    expect(args).toEqual({ mode: "release", source: "/repo", tag: "core/v1.1.0" });
  });

  it("rejects a missing/invalid tag", () => {
    expect(() =>
      parseValidatePackageArgs(["--source", "/repo", "--tag", "core"]),
    ).toThrowError(/tag/);
    expect(() => parseValidatePackageArgs(["--source", "/repo"])).toThrowError(
      /tag/,
    );
  });
});

describe("validatePackageCompatibility", () => {
  it("passes the fixture core package with an sdd-quality method", async () => {
    const result = await validatePackageCompatibility({
      mode: "release",
      source: join(FIXTURES, "release-pkg"),
      tag: "core/v1.1.0",
    });

    expect(result.packageName).toBe("core");
    expect(result.evaluationMethodCount).toBe(1);
    expect(result.flowCount).toBe(0);
  });

  it("fails when the manifest name does not match the tag package", async () => {
    await expect(
      validatePackageCompatibility({
        mode: "release",
        source: join(FIXTURES, "release-pkg"),
        tag: "wrongname/v1.1.0",
      }),
    ).rejects.toMatchObject({ code: "CONFIG" });
  });

  describe("with a temp package whose method is engine-incompatible", () => {
    let root: string;

    beforeAll(async () => {
      root = await mkdtemp(join(tmpdir(), "eval-release-gate-"));
      const methodDir = join(
        root,
        "packages",
        "core",
        "evaluation-methods",
        "future",
      );

      await mkdir(join(methodDir, "prompts"), { recursive: true });
      await mkdir(join(methodDir, "schemas"), { recursive: true });
      await writeFile(
        join(root, "packages", "core", "maister-package.yaml"),
        [
          "schemaVersion: 1",
          "name: core",
          "flows: []",
          "evaluationMethods:",
          "  - id: future",
          "    path: evaluation-methods/future",
          "",
        ].join("\n"),
      );
      await writeFile(
        join(methodDir, "evaluation-method.yaml"),
        [
          "schemaVersion: 1",
          "id: future",
          "name: Future",
          "modes: [absolute]",
          "evidence: { captureBudgetBytes: 1000 }",
          "criteria:",
          "  - id: x",
          "    name: X",
          "    weight: 1",
          "    scale: { min: 0, max: 5 }",
          "    anchors:",
          "      - { score: 0, label: a }",
          "      - { score: 5, label: b }",
          "judges:",
          "  roles:",
          "    - { id: r, name: R, count: 1, promptTemplate: prompts/j.md }",
          "  resultSchema: schemas/r.json",
          "aggregation: { algorithm: median@1 }",
          "panelPolicy:",
          "  quorum: 1",
          "  timeoutSeconds: 60",
          "  disagreement: { scoreSpreadThreshold: 1 }",
          "compat: { engine_min: 4.0.0 }",
          "",
        ].join("\n"),
      );
      await writeFile(join(methodDir, "prompts", "j.md"), "judge prompt\n");
      await writeFile(
        join(methodDir, "schemas", "r.json"),
        JSON.stringify({ type: "object" }),
      );
    });

    afterAll(async () => {
      await rm(root, { recursive: true, force: true });
    });

    it("refuses the incompatible method before any tag", async () => {
      await expect(
        validatePackageCompatibility({
          mode: "release",
          source: root,
          tag: "core/v9.9.9",
        }),
      ).rejects.toMatchObject({ code: "CONFIG" });
    });
  });
});
