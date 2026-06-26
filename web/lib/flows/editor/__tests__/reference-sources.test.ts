import type { AuthoredFlowPackageFile } from "@/lib/catalog/authored-types";

import { describe, expect, it } from "vitest";

import {
  buildAgentGroupFromFiles,
  buildRunnerGroup,
  buildSchemaOptions,
  deriveSchemaFileName,
  resolveFreeTextSourceKind,
  schemaFilePathToRef,
  schemaRefToFilePath,
  sourcePatchFromSelection,
} from "@/lib/flows/editor/reference-sources";

function packageFile(path: string): AuthoredFlowPackageFile {
  return { kind: "asset", path, content: "" };
}

describe("reference source helpers", () => {
  it("builds runner options with adapter/model/default hints", () => {
    const group = buildRunnerGroup([
      {
        id: "codex-main",
        label: "Codex Main",
        adapter: "codex",
        model: "gpt-5",
        isDefault: true,
      },
      {
        id: "claude-review",
        label: "Claude Review",
        adapter: "claude",
        model: null,
        isDefault: false,
      },
    ]);

    expect(group).toEqual({
      label: "Runners",
      kind: "runner",
      options: [
        {
          value: "codex-main",
          label: "Codex Main",
          kind: "runner",
          hint: "codex - gpt-5 - default",
        },
        {
          value: "claude-review",
          label: "Claude Review",
          kind: "runner",
          hint: "claude",
        },
      ],
    });
  });

  it("builds package-local agent options from maister-agents root files only", () => {
    const group = buildAgentGroupFromFiles("delivery-kit", [
      packageFile("maister-agents/triager.md"),
      packageFile("maister-agents/review-specialist.md"),
      packageFile("capability/review/agents/local-critic.md"),
      packageFile("agents/legacy.md"),
      packageFile("maister-agents/nested/ignored.md"),
    ]);

    expect(group).toEqual({
      label: "Agents",
      kind: "agent",
      options: [
        {
          value: "delivery-kit:review-specialist",
          label: "review-specialist",
          kind: "agent",
          filePath: "maister-agents/review-specialist.md",
        },
        {
          value: "delivery-kit:triager",
          label: "triager",
          kind: "agent",
          filePath: "maister-agents/triager.md",
        },
      ],
    });
  });

  it("builds schema options from schemas/*.json files", () => {
    const options = buildSchemaOptions([
      packageFile("schemas/review.json"),
      packageFile("schemas/nested/ignored.json"),
      packageFile("README.md"),
    ]);

    expect(options).toEqual([
      {
        value: "./schemas/review.json",
        label: "review",
        kind: "schema",
        filePath: "schemas/review.json",
      },
    ]);
  });

  it("normalizes schema refs and file paths for round trips", () => {
    expect(schemaRefToFilePath("./schemas/review.json")).toBe(
      "schemas/review.json",
    );
    expect(schemaFilePathToRef("schemas/review.json")).toBe(
      "./schemas/review.json",
    );
  });

  it("derives unique schema file names from labels", () => {
    expect(deriveSchemaFileName("Review intake", [])).toBe(
      "schemas/review-intake.json",
    );
    expect(deriveSchemaFileName("Review intake", ["schemas/review-intake.json"]))
      .toBe("schemas/review-intake-2.json");
  });

  it("resolves free text source kind from exact matches and defaults", () => {
    const runners = new Set(["codex-main"]);
    const agents = new Set(["delivery-kit:triager"]);

    expect(
      resolveFreeTextSourceKind("codex-main", { runners, agents }),
    ).toBe("runner");
    expect(
      resolveFreeTextSourceKind("delivery-kit:triager", { runners, agents }),
    ).toBe("agent");
    expect(
      resolveFreeTextSourceKind("new-runner-id", { runners, agents }),
    ).toBe("runner");
  });

  it("creates mutually exclusive source patches", () => {
    expect(sourcePatchFromSelection("runner", "codex-main")).toEqual({
      runner: "codex-main",
      agent: undefined,
    });
    expect(sourcePatchFromSelection("agent", "delivery-kit:triager")).toEqual({
      agent: "delivery-kit:triager",
      runner: undefined,
    });
  });
});
