import type { AuthoredFlowPackageFile } from "@/lib/catalog/authored-types";

import { describe, expect, it } from "vitest";

import { validateArtifactContent } from "@/lib/flows/artifact-validate";

// Builds the `files[]` shape the editor persists (kind is re-inferred by the
// validator from path, so the stored `kind` here is irrelevant filler).
function file(path: string, content: string): AuthoredFlowPackageFile {
  return { kind: "asset", path, content };
}

const VALID_FORM_SCHEMA = JSON.stringify({
  schemaVersion: 1,
  fields: [{ name: "summary", type: "string", required: true }],
});

// A JSON-valid doc that violates formSchemaSchema (fields is not an array).
const BAD_GRAMMAR_SCHEMA = JSON.stringify({
  schemaVersion: 1,
  fields: { name: "summary" },
});

const VALID_SKILL = `---
name: do-thing
description: Does the thing.
---
body`;

function codes(
  issues: ReturnType<typeof validateArtifactContent>,
): { code: string; severity: string; path: string }[] {
  return issues.map((i) => ({
    code: i.code,
    severity: i.severity,
    path: i.path,
  }));
}

describe("validateArtifactContent", () => {
  it("returns no issues for a clean package", () => {
    const issues = validateArtifactContent({
      files: [
        file("schemas/review.json", VALID_FORM_SCHEMA),
        file("skills/do/SKILL.md", VALID_SKILL),
        file("README.md", "# readme"),
      ],
      manifest: {
        nodes: [
          {
            id: "collect",
            type: "form",
            settings: { form_schema: "schemas/review.json" },
          },
        ],
      },
    });

    expect(issues).toEqual([]);
  });

  it("BLOCK schema_json_invalid when a schemas/*.json fails JSON.parse", () => {
    const issues = validateArtifactContent({
      files: [file("schemas/broken.json", "{ not json")],
      manifest: null,
    });

    expect(codes(issues)).toContainEqual({
      code: "schema_json_invalid",
      severity: "block",
      path: "schemas/broken.json",
    });
  });

  it("BLOCK form_schema_invalid when a MANIFEST-REFERENCED schema fails formSchemaSchema", () => {
    const issues = validateArtifactContent({
      files: [file("schemas/review.json", BAD_GRAMMAR_SCHEMA)],
      manifest: {
        nodes: [
          {
            id: "collect",
            type: "form",
            settings: { form_schema: "schemas/review.json" },
          },
        ],
      },
    });

    const found = codes(issues);

    expect(found).toContainEqual({
      code: "form_schema_invalid",
      severity: "block",
      path: "schemas/review.json",
    });
    // It is referenced → must NOT also be reported as the unreferenced WARN.
    expect(found.some((i) => i.code === "form_schema_unreferenced")).toBe(
      false,
    );
  });

  it("resolves an output.result.schema reference (./-prefixed) as referenced → BLOCK", () => {
    const issues = validateArtifactContent({
      files: [file("schemas/out.json", BAD_GRAMMAR_SCHEMA)],
      manifest: {
        nodes: [
          {
            id: "work",
            type: "ai_coding",
            output: { result: { schema: "./schemas/out.json" } },
          },
        ],
      },
    });

    expect(codes(issues)).toContainEqual({
      code: "form_schema_invalid",
      severity: "block",
      path: "schemas/out.json",
    });
  });

  it("WARN form_schema_unreferenced when a bad-grammar schema is NOT referenced", () => {
    const issues = validateArtifactContent({
      files: [file("schemas/orphan.json", BAD_GRAMMAR_SCHEMA)],
      manifest: { nodes: [{ id: "work", type: "ai_coding" }] },
    });

    const found = codes(issues);

    expect(found).toContainEqual({
      code: "form_schema_unreferenced",
      severity: "warn",
      path: "schemas/orphan.json",
    });
    expect(found.some((i) => i.code === "form_schema_invalid")).toBe(false);
    // JSON parsed fine → no schema_json_invalid.
    expect(found.some((i) => i.code === "schema_json_invalid")).toBe(false);
  });

  it("BLOCK frontmatter_field_missing when a skill SKILL.md lacks description", () => {
    const issues = validateArtifactContent({
      files: [
        file(
          "skills/do/SKILL.md",
          `---
name: do-thing
---
body`,
        ),
      ],
      manifest: null,
    });

    expect(codes(issues)).toContainEqual({
      code: "frontmatter_field_missing",
      severity: "block",
      path: "skills/do/SKILL.md",
    });
  });

  it("BLOCK frontmatter_field_missing when an agent md lacks name", () => {
    const issues = validateArtifactContent({
      files: [
        file(
          "agents/reviewer.md",
          `---
description: Reviews code.
---
body`,
        ),
      ],
      manifest: null,
    });

    expect(codes(issues)).toContainEqual({
      code: "frontmatter_field_missing",
      severity: "block",
      path: "agents/reviewer.md",
    });
  });

  it("BLOCK frontmatter_missing when a skill SKILL.md has no frontmatter", () => {
    const issues = validateArtifactContent({
      files: [file("skills/do/SKILL.md", "no fence here, just markdown")],
      manifest: null,
    });

    expect(codes(issues)).toContainEqual({
      code: "frontmatter_missing",
      severity: "block",
      path: "skills/do/SKILL.md",
    });
  });

  it("BLOCK frontmatter_missing when frontmatter is malformed (unterminated fence)", () => {
    const issues = validateArtifactContent({
      files: [
        file(
          "agents/reviewer.md",
          `---
name: x
description: y
body without closing fence`,
        ),
      ],
      manifest: null,
    });

    expect(codes(issues)).toContainEqual({
      code: "frontmatter_missing",
      severity: "block",
      path: "agents/reviewer.md",
    });
  });

  it("no issues for skill AUX files without frontmatter (only skills/**/SKILL.md is gated)", () => {
    const issues = validateArtifactContent({
      files: [
        file("skills/demo/references/notes.md", "plain reference notes"),
        file("skills/demo/fixtures/example.txt", "fixture body"),
      ],
      manifest: null,
    });

    expect(issues).toEqual([]);
  });

  it("no issues for agent helper files outside agents/*.md (nested dirs, non-md)", () => {
    const issues = validateArtifactContent({
      files: [
        file("agents/helpers/notes.md", "no frontmatter here"),
        file("agents/prompt.txt", "raw prompt text"),
      ],
      manifest: null,
    });

    expect(issues).toEqual([]);
  });

  it("BLOCK frontmatter_missing still applies to a NESTED skills/**/SKILL.md", () => {
    const issues = validateArtifactContent({
      files: [file("skills/group/sub/SKILL.md", "no fence, just markdown")],
      manifest: null,
    });

    expect(codes(issues)).toContainEqual({
      code: "frontmatter_missing",
      severity: "block",
      path: "skills/group/sub/SKILL.md",
    });
  });

  it("WARN rule_guardrail_shape when rule frontmatter shape is malformed (never blocks)", () => {
    const issues = validateArtifactContent({
      files: [
        file(
          "rules/guard.md",
          `---
allowed_paths: "should-be-an-array"
---
body`,
        ),
      ],
      manifest: null,
    });

    const found = codes(issues);

    expect(found).toContainEqual({
      code: "rule_guardrail_shape",
      severity: "warn",
      path: "rules/guard.md",
    });
    expect(found.every((i) => i.severity === "warn")).toBe(true);
  });

  it("WARN frontmatter_unknown_key for an unknown skill frontmatter key", () => {
    const issues = validateArtifactContent({
      files: [
        file(
          "skills/do/SKILL.md",
          `---
name: do-thing
description: Does the thing.
totally-unknown-key: 1
---
body`,
        ),
      ],
      manifest: null,
    });

    expect(codes(issues)).toContainEqual({
      code: "frontmatter_unknown_key",
      severity: "warn",
      path: "skills/do/SKILL.md",
    });
  });

  it("BLOCK for an unknown agent frontmatter key (ADR-089 strict platform-agent contract)", () => {
    const issues = validateArtifactContent({
      files: [
        file(
          "agents/reviewer.md",
          `---
name: reviewer
description: Reviews code.
team: backend
workspace: none
mode: session
triggers:
  - manual
risk_tier: read_only
---
body`,
        ),
      ],
      manifest: null,
    });

    expect(codes(issues)).toContainEqual({
      code: "frontmatter_field_missing",
      severity: "block",
      path: "agents/reviewer.md",
    });
    expect(
      issues.find((i) => i.path === "agents/reviewer.md")?.message,
    ).toMatch(/team|unrecognized/i);
  });

  it("WARN frontmatter_unknown_key for an unknown rule frontmatter key (Gap 4)", () => {
    const issues = validateArtifactContent({
      files: [
        file(
          "rules/guard.md",
          `---
allowed_paths:
  - src/**
note: keep it tidy
---
body`,
        ),
      ],
      manifest: null,
    });

    expect(codes(issues)).toContainEqual({
      code: "frontmatter_unknown_key",
      severity: "warn",
      path: "rules/guard.md",
    });
  });

  it("manifest-null: file-level BLOCK checks still run, manifest-reference checks skipped", () => {
    const issues = validateArtifactContent({
      files: [
        file("schemas/broken.json", "{ not json"), // file-level BLOCK
        file("schemas/orphan.json", BAD_GRAMMAR_SCHEMA), // would be referenced-or-not, but manifest null
        file("skills/do/SKILL.md", "no frontmatter"), // file-level BLOCK
      ],
      manifest: null,
    });

    const found = codes(issues);

    // File-level BLOCKs fire regardless of manifest.
    expect(found).toContainEqual({
      code: "schema_json_invalid",
      severity: "block",
      path: "schemas/broken.json",
    });
    expect(found).toContainEqual({
      code: "frontmatter_missing",
      severity: "block",
      path: "skills/do/SKILL.md",
    });
    // With manifest null, NO reference resolution → the bad-grammar orphan is
    // treated as unreferenced (WARN), never form_schema_invalid (BLOCK).
    expect(found.some((i) => i.code === "form_schema_invalid")).toBe(false);
    expect(found).toContainEqual({
      code: "form_schema_unreferenced",
      severity: "warn",
      path: "schemas/orphan.json",
    });
  });

  it("WARN shell_lint for a scripts/*.sh with a smell (missing shebang) (F2)", () => {
    const issues = validateArtifactContent({
      files: [file("scripts/run.sh", "echo building\nset -e\n")],
      manifest: null,
    });

    const found = codes(issues);

    expect(found).toContainEqual({
      code: "shell_lint",
      severity: "warn",
      path: "scripts/run.sh",
    });
    // shell_lint is advisory only — it must never raise a BLOCK.
    expect(
      issues.every((i) => i.code !== "shell_lint" || i.severity === "warn"),
    ).toBe(true);
  });

  it("WARN shell_lint for setup.sh too (F2)", () => {
    const issues = validateArtifactContent({
      files: [file("setup.sh", "echo installing\nset -e\n")],
      manifest: null,
    });

    expect(codes(issues)).toContainEqual({
      code: "shell_lint",
      severity: "warn",
      path: "setup.sh",
    });
  });

  it("collects form_schema references from legacy steps[] too", () => {
    const issues = validateArtifactContent({
      files: [file("schemas/review.json", BAD_GRAMMAR_SCHEMA)],
      manifest: {
        steps: [
          { id: "review", type: "human", form_schema: "schemas/review.json" },
        ],
      },
    });

    expect(codes(issues)).toContainEqual({
      code: "form_schema_invalid",
      severity: "block",
      path: "schemas/review.json",
    });
  });
});
