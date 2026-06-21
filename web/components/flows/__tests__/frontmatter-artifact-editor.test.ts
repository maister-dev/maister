import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
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
  agentWorkspace: "Workspace",
  agentWorkspaceRef: "Workspace ref",
  agentMode: "Mode",
  agentTriggers: "Triggers",
  agentRiskTier: "Risk tier",
  agentRunner: "Runner",
  agentRecommendedHeading: "Recommended bindings",
  agentRecommendedRunner: "Recommended runner",
  agentRecommendedCronExpr: "Recommended cron expression",
  agentRecommendedCronTz: "Recommended cron timezone",
  agentRecommendedEvents: "Recommended event kinds",
  allowedPaths: "Allowed paths",
  forbiddenPaths: "Forbidden paths",
  allowedCommands: "Allowed commands",
  requireStructuredResponse: "Require structured response",
  listHint: "One per line",
  guardrailNotice: "Guardrails are advisory and never block execution.",
  malformedNotice:
    "The frontmatter could not be parsed. Fix it in the raw view below.",
  rawHeading: "Raw content",
  agentSchemaWarning: "Platform-agent frontmatter has issues.",
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

// ADR-089 rework: agents/*.md is the PLATFORM agent contract.
const AGENT_CONTENT = `---
name: reviewer
description: Reviews a diff
runner: claude-default
workspace: repo_read
workspace_ref: trigger
mode: session
triggers:
  - manual
  - domain_event
risk_tier: read_only
recommended:
  runner: claude-default
  cron:
    expr: "*/30 * * * *"
    timezone: UTC
  events:
    - run.failed
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
    const next = applyFrontmatterFieldEdit(AGENT_CONTENT, "runner", undefined);

    expect(next).not.toContain("runner: claude-default\nworkspace");
    // Sibling keys survive.
    expect(next).toContain("workspace: repo_read");
    expect(next).toContain("risk_tier: read_only");
  });

  it("round-trips a `triggers` edit as a YAML sequence (F1 invariant)", () => {
    const next = applyFrontmatterFieldEdit(AGENT_CONTENT, "triggers", [
      "manual",
      "cron",
    ]);

    expect(next).not.toContain("triggers: manual,cron");
    expect(next).toContain("- manual");
    expect(next).toContain("- cron");

    const fm = splitFrontmatter(next);

    expect(fm.ok).toBe(true);
    if (fm.ok) {
      expect(fm.frontmatter?.triggers).toEqual(["manual", "cron"]);
    }
  });

  it("round-trips a nested `recommended` mapping edit", () => {
    const next = applyFrontmatterFieldEdit(AGENT_CONTENT, "recommended", {
      runner: "codex-default",
      events: ["run.done"],
    });

    const fm = splitFrontmatter(next);

    expect(fm.ok).toBe(true);
    if (fm.ok) {
      expect(fm.frontmatter?.recommended).toEqual({
        runner: "codex-default",
        events: ["run.done"],
      });
    }
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
    expect(html).not.toContain("Risk tier");
  });
});

describe("FrontmatterArtifactEditor — agent_definition", () => {
  it("renders the platform-agent contract fields populated from content", () => {
    const html = renderToStaticMarkup(
      createElement(FrontmatterArtifactEditor, {
        content: AGENT_CONTENT,
        kind: "agent_definition",
        labels,
        onChange: () => {},
      }),
    );

    expect(html).toContain('value="reviewer"');
    expect(html).toContain("Workspace");
    expect(html).toContain('value="repo_read"');
    expect(html).toContain('value="trigger"');
    expect(html).toContain("Risk tier");
    expect(html).toContain('value="read_only"');
    // triggers render as a one-per-line LIST field.
    expect(html).toContain("manual\ndomain_event");
    // recommended sub-fields pre-populate.
    expect(html).toContain("Recommended bindings");
    expect(html).toContain('value="*/30 * * * *"');
    expect(html).toContain('value="UTC"');
    expect(html).toContain("run.failed");
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
