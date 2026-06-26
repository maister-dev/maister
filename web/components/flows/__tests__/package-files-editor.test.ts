import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PackageFilesEditor } from "@/components/flows/package-files-editor";
import { packageFilesToSubmitValue } from "@/lib/flows/editor/package-files-draft";

const KIND_LABELS = {
  asset: "Asset",
  agent_definition: "Agent definition",
  manifest: "Package manifest",
  readme: "README",
  rule: "Rule",
  schema: "Schema",
  script: "Script",
  setup: "Setup",
  skill: "Skill",
  subagent: "Subagent",
  template: "Template",
};

const FRONTMATTER_LABELS = {
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
  agentCapabilityProfile: "Capability profile (JSON object)",
  agentCapabilityProfileInvalid: "Invalid JSON object",
  allowedPaths: "Allowed paths",
  forbiddenPaths: "Forbidden paths",
  allowedCommands: "Allowed commands",
  requireStructuredResponse: "Require structured response",
  listHint: "One per line",
  guardrailNotice: "Guardrails are advisory.",
  malformedNotice: "The frontmatter could not be parsed.",
  rawHeading: "Raw content",
  agentSchemaWarning: "Platform-agent frontmatter has issues.",
  subagentSchemaWarning: "Subagent frontmatter has issues.",
};

const SCRIPT_LABELS = {
  editorAriaLabel: "Script editor",
  trustBannerTitle: "Execution is gated by trust.",
  trustBanner: "Scripts never run until explicit executable trust.",
};

const FORM_SCHEMA_LABELS = {
  builderTab: "Builder",
  jsonTab: "Raw JSON",
  previewHeading: "Live preview",
  fieldName: "Name",
  fieldLabel: "Label",
  fieldType: "Type",
  fieldRequired: "Required",
  fieldOptions: "Options",
  addField: "Add field",
  addNestedField: "Add nested field",
  removeField: "Remove",
  moveUp: "Move up",
  moveDown: "Move down",
  invalidJson: "The JSON is invalid.",
  noFields: "No fields yet.",
  type: {
    string: "String",
    number: "Number",
    boolean: "Boolean",
    enum: "Enum",
    array: "Array",
    object: "Object",
  },
  preview: {
    criticalityLabel: "Criticality",
    "criticality.low": "low",
    "criticality.medium": "medium",
    "criticality.high": "high",
    "criticality.critical": "critical",
    confidenceLabel: "Confidence",
    reviewComments: "Review comments",
    decisionApprove: "Approve",
    decisionRework: "Request rework",
    sendBackWithComments: "Send back with comments",
    responseLabel: "Response (JSON)",
    responseHint: "Enter a JSON value.",
    schemaLabel: "Requested schema",
    submit: "Submit",
    reviewCommentsPlaceholder: "What needs to change?",
    formInstructions: "Pick an option or type your own.",
    formCustomPlaceholder: "Type a custom value…",
  },
};

const CONTENT_ISSUES_LABELS = {
  clean: "No content issues.",
  blockTitle: "Blocking issues",
  warnTitle: "Warnings",
};

const MANIFEST_LABELS = {
  heading: "Package manifest",
  name: "Name",
  displayTitle: "Title",
  summary: "Summary",
  flows: "Flows",
  capabilities: "Capabilities",
  mcps: "MCP servers",
  restrictions: "Restrictions",
  formMode: "Form",
  rawMode: "Raw",
  parseError: "The manifest could not be parsed.",
  empty: "None",
};

const LABELS = {
  addFile: "Add file",
  cancel: "Cancel",
  content: "Content",
  editPathTitle: "Edit path",
  kind: "Kind",
  noFiles: "No package files yet.",
  path: "Path",
  pathError: {
    unsafe_path: "Path must be relative and must not contain ..",
    duplicate_path: "Another file already uses this path.",
    path_conflict: "Path conflicts with an existing file or folder.",
  },
  removeFile: "Remove",
  renamePath: "Rename / move",
  save: "Save",
  frontmatter: FRONTMATTER_LABELS,
  script: SCRIPT_LABELS,
  formSchema: FORM_SCHEMA_LABELS,
  contentIssues: CONTENT_ISSUES_LABELS,
  manifest: MANIFEST_LABELS,
};

function hiddenPackageFilesValue(html: string): string {
  const match = /name="packageFilesJson"[^>]*value="([^"]*)"/.exec(html);

  if (!match) throw new Error("packageFilesJson hidden input missing");

  return match[1]
    .replaceAll("&quot;", '"')
    .replaceAll("&#x27;", "'")
    .replaceAll("&amp;", "&");
}

describe("PackageFilesEditor", () => {
  it("renders a derived file tree, an inferred-kind badge, and keeps the hidden JSON field", () => {
    const html = renderToStaticMarkup(
      createElement(PackageFilesEditor, {
        disabled: false,
        files: [
          {
            kind: "skill",
            path: "skills/deploy/SKILL.md",
            content: "# Deploy\n",
          },
          { kind: "readme", path: "README.md", content: "Hello" },
        ],
        kindLabels: KIND_LABELS,
        labels: LABELS,
      }),
    );

    // hidden save contract preserved exactly
    expect(html).toContain('name="packageFilesJson"');
    expect(html).toContain('type="hidden"');

    // derived tree: folder segments + leaf name appear (not only the flat path)
    expect(html).toContain("skills");
    expect(html).toContain("deploy");
    expect(html).toContain("SKILL.md");
    expect(html).toContain("README.md");

    // inferred-kind badge for the (default-selected) first file
    expect(html).toContain("Skill");

    // editing actions present in editable mode
    expect(html).toContain("Add file");
    expect(html).toContain("Remove");
    expect(html).toContain("Rename / move");

    // the manual kind <select> is GONE
    expect(html).not.toContain("<select");
  });

  it("renders viewers as read-only inspectors with no editing affordances", () => {
    const html = renderToStaticMarkup(
      createElement(PackageFilesEditor, {
        disabled: true,
        files: [{ kind: "readme", path: "README.md", content: "Hello" }],
        kindLabels: KIND_LABELS,
        labels: LABELS,
      }),
    );

    expect(html).toContain("README.md");
    // inferred-kind badge still shows in read-only mode
    expect(html).toContain("README");
    expect(html).not.toContain("<select");
    expect(html).not.toContain("Add file");
    expect(html).not.toContain("Remove");
    expect(html).not.toContain("Rename / move");
  });

  it("shows the empty state when there are no files", () => {
    const html = renderToStaticMarkup(
      createElement(PackageFilesEditor, {
        disabled: false,
        files: [],
        kindLabels: KIND_LABELS,
        labels: LABELS,
      }),
    );

    expect(html).toContain('name="packageFilesJson"');
    expect(html).toContain("No package files yet.");
    expect(html).toContain("Add file");
  });

  it("serializes uncontrolled files into the hidden submit field", () => {
    const files = [
      { kind: "readme" as const, path: "README.md", content: "Hello" },
    ];
    const html = renderToStaticMarkup(
      createElement(PackageFilesEditor, {
        disabled: false,
        files,
        kindLabels: KIND_LABELS,
        labels: LABELS,
      }),
    );

    expect(hiddenPackageFilesValue(html)).toBe(packageFilesToSubmitValue(files));
  });

  it("serializes controlled files from props and renders the same file tree", () => {
    const files = [
      {
        kind: "schema" as const,
        path: "schemas/review.json",
        content: '{"fields":[]}',
      },
    ];
    const html = renderToStaticMarkup(
      createElement(PackageFilesEditor, {
        disabled: false,
        files,
        kindLabels: KIND_LABELS,
        labels: LABELS,
        onFilesChange: () => undefined,
      }),
    );

    expect(hiddenPackageFilesValue(html)).toBe(packageFilesToSubmitValue(files));
    expect(html).toContain("schemas");
    expect(html).toContain("review.json");
  });

  it("dispatches a selected SKILL.md to the frontmatter artifact editor", () => {
    const html = renderToStaticMarkup(
      createElement(PackageFilesEditor, {
        disabled: false,
        files: [
          {
            kind: "skill",
            path: "skills/demo/SKILL.md",
            content:
              "---\nname: Demo\ndescription: A demo skill\n---\n# Demo\n",
          },
        ],
        kindLabels: KIND_LABELS,
        labels: LABELS,
      }),
    );

    // frontmatter form surfaced (heading + name/description fields), not the
    // bare generic CodeEditor host.
    expect(html).toContain("Frontmatter");
    expect(html).toContain("Name");
    expect(html).toContain("Description");
    expect(html).not.toContain('data-testid="script-exec-trust-banner"');
    expect(html).not.toContain('data-testid="form-schema-builder"');
  });

  it("dispatches a selected scripts/*.sh to the script artifact editor", () => {
    const html = renderToStaticMarkup(
      createElement(PackageFilesEditor, {
        disabled: false,
        files: [
          { kind: "script", path: "scripts/run.sh", content: "echo hi\n" },
        ],
        kindLabels: KIND_LABELS,
        labels: LABELS,
      }),
    );

    expect(html).toContain('data-testid="script-exec-trust-banner"');
    expect(html).toContain("Execution is gated by trust.");
  });

  it("dispatches a selected schemas/*.json to the form-schema builder", () => {
    const html = renderToStaticMarkup(
      createElement(PackageFilesEditor, {
        disabled: false,
        files: [
          {
            kind: "schema",
            path: "schemas/review.json",
            content: '{"fields":[]}',
          },
        ],
        kindLabels: KIND_LABELS,
        labels: LABELS,
      }),
    );

    expect(html).toContain('data-testid="form-schema-builder"');
  });

  it("renders the generic fallback editor for a README.md", () => {
    const html = renderToStaticMarkup(
      createElement(PackageFilesEditor, {
        disabled: false,
        files: [{ kind: "readme", path: "README.md", content: "Hello" }],
        kindLabels: KIND_LABELS,
        labels: LABELS,
      }),
    );

    expect(html).toContain('data-testid="code-editor"');
    expect(html).not.toContain("Frontmatter");
    expect(html).not.toContain('data-testid="script-exec-trust-banner"');
    expect(html).not.toContain('data-testid="form-schema-builder"');
  });

  it("surfaces a BLOCK content issue (SKILL.md missing description)", () => {
    const html = renderToStaticMarkup(
      createElement(PackageFilesEditor, {
        disabled: false,
        files: [
          {
            kind: "skill",
            path: "skills/demo/SKILL.md",
            content: "---\nname: Demo\n---\n# Demo\n",
          },
        ],
        kindLabels: KIND_LABELS,
        labels: LABELS,
      }),
    );

    expect(html).toContain('data-testid="artifact-content-issues"');
    expect(html).toContain('data-testid="artifact-content-block"');
  });

  it("dispatches a selected maister-package.yaml to the package manifest form (M39 A1)", () => {
    const html = renderToStaticMarkup(
      createElement(PackageFilesEditor, {
        disabled: false,
        files: [
          {
            kind: "manifest",
            path: "maister-package.yaml",
            content: "schemaVersion: 1\nname: demo\nflows: []\n",
          },
        ],
        kindLabels: KIND_LABELS,
        labels: LABELS,
      }),
    );

    expect(html).toContain('data-testid="package-manifest-form"');
    expect(html).toContain('data-testid="manifest-field-name"');
  });

  it("dispatches a selected capability subagent .md to the frontmatter editor (M39 A4)", () => {
    const html = renderToStaticMarkup(
      createElement(PackageFilesEditor, {
        disabled: false,
        files: [
          {
            kind: "subagent",
            path: "capability/demo/agents/helper.md",
            content: "---\nname: helper\ndescription: A helper\n---\nBody\n",
          },
        ],
        kindLabels: KIND_LABELS,
        labels: LABELS,
      }),
    );

    // Lands in the lenient frontmatter artifact editor (heading + name field),
    // not the script or form-schema host. (The frontmatter body itself renders
    // via a readme code-editor, so that testid is expected here.)
    expect(html).toContain("Frontmatter");
    expect(html).toContain('value="helper"');
    expect(html).toContain('value="A helper"');
    expect(html).not.toContain('data-testid="script-exec-trust-banner"');
    expect(html).not.toContain('data-testid="form-schema-builder"');
  });

  it("honors initialSelectedPath over the first-file default", () => {
    const html = renderToStaticMarkup(
      createElement(PackageFilesEditor, {
        disabled: false,
        files: [
          { kind: "readme", path: "README.md", content: "Hello" },
          {
            kind: "manifest",
            path: "maister-package.yaml",
            content: "schemaVersion: 1\nname: demo\nflows: []\n",
          },
        ],
        initialSelectedPath: "maister-package.yaml",
        kindLabels: KIND_LABELS,
        labels: LABELS,
      }),
    );

    // The manifest (not the first-file README) is selected + rendered.
    expect(html).toContain('data-testid="package-manifest-form"');
  });

  it("falls back to the first file when initialSelectedPath is absent from files", () => {
    const html = renderToStaticMarkup(
      createElement(PackageFilesEditor, {
        disabled: false,
        files: [
          { kind: "readme", path: "README.md", content: "Hello" },
          {
            kind: "manifest",
            path: "maister-package.yaml",
            content: "schemaVersion: 1\nname: demo\nflows: []\n",
          },
        ],
        initialSelectedPath: "does/not/exist.yaml",
        kindLabels: KIND_LABELS,
        labels: LABELS,
      }),
    );

    // README (first file) renders via the generic editor; the manifest form does not.
    expect(html).toContain('data-testid="code-editor"');
    expect(html).not.toContain('data-testid="package-manifest-form"');
  });
});
