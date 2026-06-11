import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";

import {
  FrontmatterArtifactEditor,
  applyFrontmatterFieldEdit,
  type FrontmatterArtifactEditorLabels,
} from "@/components/flows/artifact-editors/frontmatter-artifact-editor";
import { splitFrontmatter } from "@/lib/flows/artifact-frontmatter";

const labels: FrontmatterArtifactEditorLabels = {
  frontmatterHeading: "Frontmatter",
  bodyHeading: "Body",
  name: "Name",
  description: "Description",
  tools: "Tools",
  model: "Model",
  permissionMode: "Permission mode",
  maxTurns: "Max turns",
  allowedPaths: "Allowed paths",
  forbiddenPaths: "Forbidden paths",
  allowedCommands: "Allowed commands",
  requireStructuredResponse: "Require structured response",
  listHint: "One per line",
  guardrailNotice: "Guardrails are advisory and never block execution.",
  malformedNotice:
    "The frontmatter could not be parsed. Fix it in the raw view below.",
  rawHeading: "Raw content",
};

const SKILL_CONTENT = `---
name: bugfix
description: Fix a reported defect
argument-hint: "<issue url>"
allowed-tools:
  - Read
  - Edit
---
# Bugfix skill

Do the thing.
`;

const AGENT_CONTENT = `---
name: reviewer
description: Reviews a diff
tools: Read, Grep
model: claude-sonnet-4-6
permissionMode: acceptEdits
maxTurns: 12
team: backend
---
You are a reviewer.
`;

const AGENT_TOOLS_ARRAY_CONTENT = `---
name: reviewer
description: Reviews a diff
tools:
  - Bash
  - Read
maxTurns: 12
---
You are a reviewer.
`;

const RULE_CONTENT = `---
allowed_paths:
  - src/**
forbidden_paths:
  - secrets/**
allowed_commands:
  - pnpm test
require_structured_response: true
note: keep it tidy
---
Follow these guardrails.
`;

const MALFORMED_CONTENT = `---
name: broken
description: "unterminated
# no closing fence and bad yaml
`;

describe("applyFrontmatterFieldEdit", () => {
  it("edits a known field and keeps unknown keys + body byte-stable", () => {
    const next = applyFrontmatterFieldEdit(
      SKILL_CONTENT,
      "description",
      "Fix it harder",
    );

    expect(next).not.toBe(SKILL_CONTENT);
    expect(next).toContain("description: Fix it harder");
    // Unknown / passthrough keys preserved verbatim.
    expect(next).toContain("argument-hint:");
    expect(next).toContain("- Read");
    expect(next).toContain("- Edit");
    // Body untouched.
    expect(next).toContain("# Bugfix skill");
    expect(next).toContain("Do the thing.");
    // Name not corrupted.
    expect(next).toContain("name: bugfix");
  });

  it("is a fixed point when re-applying the existing value (round-trip stable)", () => {
    // Seed from already-canonical content (one serialize pass), then assert the
    // pipeline is idempotent: editing an untouched field to its current value
    // is byte-stable. (Source quoting style is normalised by the first pass —
    // the invariant is "no further drift", not "matches hand-written yaml".)
    const canonical = applyFrontmatterFieldEdit(
      SKILL_CONTENT,
      "name",
      "bugfix",
    );
    const same = applyFrontmatterFieldEdit(canonical, "name", "bugfix");

    expect(same).toBe(canonical);
    // Untouched fields and body survive byte-for-byte across the no-op edit.
    expect(same).toContain("description: Fix a reported defect");
    expect(same).toContain("# Bugfix skill");
  });

  it("returns content unchanged when frontmatter is malformed", () => {
    const next = applyFrontmatterFieldEdit(
      MALFORMED_CONTENT,
      "description",
      "whatever",
    );

    expect(next).toBe(MALFORMED_CONTENT);
  });

  it("removes a key when the next value is undefined", () => {
    const next = applyFrontmatterFieldEdit(AGENT_CONTENT, "model", undefined);

    expect(next).not.toContain("model:");
    // Sibling keys survive.
    expect(next).toContain("permissionMode: acceptEdits");
    expect(next).toContain("team: backend");
  });

  it("round-trips an array `tools` edit as a YAML sequence (F1 BLOCKER)", () => {
    const next = applyFrontmatterFieldEdit(AGENT_TOOLS_ARRAY_CONTENT, "tools", [
      "Bash",
      "Read",
    ]);

    // The agent `tools` field is a YAML sequence, NOT the flattened string
    // `tools: Bash,Read`.
    expect(next).not.toContain("tools: Bash,Read");
    expect(next).toContain("- Bash");
    expect(next).toContain("- Read");

    const fm = splitFrontmatter(next);

    expect(fm.ok).toBe(true);
    if (fm.ok) {
      expect(Array.isArray(fm.frontmatter?.tools)).toBe(true);
      expect(fm.frontmatter?.tools).toEqual(["Bash", "Read"]);
    }
  });

  it("keeps `maxTurns` a YAML number across an edit (F1 BLOCKER)", () => {
    const next = applyFrontmatterFieldEdit(
      AGENT_TOOLS_ARRAY_CONTENT,
      "maxTurns",
      20,
    );

    expect(next).toContain("maxTurns: 20");

    const parsed = parseYaml(
      next.slice(next.indexOf("\n") + 1, next.lastIndexOf("\n---")),
    ) as { maxTurns?: unknown };

    expect(typeof parsed.maxTurns).toBe("number");
    expect(parsed.maxTurns).toBe(20);
  });
});

describe("FrontmatterArtifactEditor — skill", () => {
  it("renders name + description fields populated from content", () => {
    const html = renderToStaticMarkup(
      createElement(FrontmatterArtifactEditor, {
        content: SKILL_CONTENT,
        kind: "skill",
        labels,
        onChange: () => {},
      }),
    );

    expect(html).toContain("Frontmatter");
    expect(html).toContain('value="bugfix"');
    expect(html).toContain("Fix a reported defect");
    // No agent-only field on a skill editor.
    expect(html).not.toContain("Permission mode");
  });
});

describe("FrontmatterArtifactEditor — agent_definition", () => {
  it("renders agent fields populated from content", () => {
    const html = renderToStaticMarkup(
      createElement(FrontmatterArtifactEditor, {
        content: AGENT_CONTENT,
        kind: "agent_definition",
        labels,
        onChange: () => {},
      }),
    );

    expect(html).toContain('value="reviewer"');
    expect(html).toContain("Permission mode");
    expect(html).toContain('value="acceptEdits"');
    expect(html).toContain('value="claude-sonnet-4-6"');
    // maxTurns rendered as a number input value.
    expect(html).toContain('value="12"');
  });

  it("renders an array `tools` as a one-per-line LIST field, not a flattened string (F1 BLOCKER)", () => {
    const html = renderToStaticMarkup(
      createElement(FrontmatterArtifactEditor, {
        content: AGENT_TOOLS_ARRAY_CONTENT,
        kind: "agent_definition",
        labels,
        onChange: () => {},
      }),
    );

    // A LIST field renders the array as newline-joined textarea text, never the
    // comma-flattened `value="Bash,Read"` a TextField would emit.
    expect(html).not.toContain('value="Bash,Read"');
    expect(html).toContain("Bash\nRead");
  });
});

describe("FrontmatterArtifactEditor — rule", () => {
  it("renders guardrail fields + the advisory notice", () => {
    const html = renderToStaticMarkup(
      createElement(FrontmatterArtifactEditor, {
        content: RULE_CONTENT,
        kind: "rule",
        labels,
        onChange: () => {},
      }),
    );

    expect(html).toContain("Allowed paths");
    expect(html).toContain("Forbidden paths");
    expect(html).toContain("Allowed commands");
    expect(html).toContain("src/**");
    expect(html).toContain("secrets/**");
    // WARN-level advisory copy is always shown for rules.
    expect(html).toContain(
      "Guardrails are advisory and never block execution.",
    );
    // require_structured_response surfaces as a checked box.
    expect(html).toContain("checked");
  });
});

describe("FrontmatterArtifactEditor — malformed", () => {
  it("shows the malformed notice instead of crashing", () => {
    const html = renderToStaticMarkup(
      createElement(FrontmatterArtifactEditor, {
        content: MALFORMED_CONTENT,
        kind: "skill",
        labels,
        onChange: () => {},
      }),
    );

    expect(html).toContain(
      "The frontmatter could not be parsed. Fix it in the raw view below.",
    );
    expect(html).toContain("Raw content");
    // The structured name field must NOT render in malformed mode.
    expect(html).not.toContain("Frontmatter");
  });
});
