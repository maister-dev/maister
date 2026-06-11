// T4.6 (RED): render tests for the self-contained form_schema builder.
// renderToStaticMarkup (no jsdom), mirroring package-files-editor.test.ts. The
// two-way builder⇄JSON sync is unit-tested as a pure reducer
// (lib/flows/editor/__tests__/form-schema-edit.test.ts); here we assert only the
// static markup contract: builder rows from a valid schema, the disabled-banner
// on invalid JSON, and the live-preview pane (HitlDecisionControls fields).
//
// Contract (module not built yet — RED on the missing import):
//   web/components/flows/artifact-editors/form-schema-builder.tsx exports
//     FormSchemaBuilder({ content, onChange, readOnly?, labels }): ReactElement

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { FormSchemaBuilder } from "@/components/flows/artifact-editors/form-schema-builder";

type BuilderProps = Parameters<typeof FormSchemaBuilder>[0];

const LABELS: BuilderProps["labels"] = {
  builderTab: "Builder",
  jsonTab: "Raw JSON",
  previewHeading: "Live preview",
  fieldName: "Name",
  fieldLabel: "Label",
  fieldType: "Type",
  fieldRequired: "Required",
  fieldOptions: "Options (comma-separated)",
  addField: "Add field",
  addNestedField: "Add nested field",
  removeField: "Remove",
  moveUp: "Move up",
  moveDown: "Move down",
  invalidJson: "The JSON is invalid — fix it to re-enable the builder.",
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
    "criticality.low": "Low",
    "criticality.medium": "Medium",
    "criticality.high": "High",
    "criticality.critical": "Critical",
    confidenceLabel: "Confidence",
    reviewComments: "Review comments",
    decisionApprove: "Approve",
    decisionRework: "Rework",
    sendBackWithComments: "Send back",
    responseLabel: "Response",
    responseHint: "Respond as JSON",
    schemaLabel: "Schema",
    submit: "Submit",
    reviewCommentsPlaceholder: "Comments",
    formInstructions: "Fill the form",
    formCustomPlaceholder: "Custom value",
  },
};

const VALID = JSON.stringify({
  schemaVersion: 1,
  fields: [
    { name: "tests", label: "Tests", type: "enum", options: ["yes", "no"] },
    { name: "notes", type: "string" },
  ],
});

function render(over: Partial<BuilderProps> = {}): string {
  const base: BuilderProps = {
    content: VALID,
    labels: LABELS,
    onChange: () => {},
  };

  return renderToStaticMarkup(
    createElement(FormSchemaBuilder, { ...base, ...over }),
  );
}

describe("FormSchemaBuilder — markup", () => {
  it("renders a structured row per field from a valid schema", () => {
    const html = render();

    expect(html).toContain('data-testid="form-schema-builder"');
    // one editable name input per field, carrying the field name as its value
    expect(html).toContain('value="tests"');
    expect(html).toContain('value="notes"');
    // the author-provided label round-trips into the label input
    expect(html).toContain('value="Tests"');
    // a field-type control is present
    expect(html).toContain("Type");
  });

  it("renders enum options joined for an enum field", () => {
    const html = render();

    // options serialized comma-joined into the options input value
    expect(html).toContain("yes, no");
  });

  it("offers add / remove / reorder affordances", () => {
    const html = render();

    expect(html).toContain('data-testid="form-schema-add-field"');
    expect(html).toContain('data-testid="form-schema-remove-field-0"');
    expect(html).toContain('data-testid="form-schema-move-up-1"');
    expect(html).toContain('data-testid="form-schema-move-down-0"');
  });

  it("renders the raw-JSON editor alongside the builder", () => {
    const html = render();

    // CodeEditor host (kind=schema) is always mounted for the JSON toggle
    expect(html).toContain('data-testid="code-editor"');
  });

  it("renders the live preview pane with the extracted fields", () => {
    const html = render();

    expect(html).toContain('data-testid="form-schema-preview"');
    // HitlDecisionControls renders the field labels + option buttons
    expect(html).toContain("Live preview");
    expect(html).toContain("Tests");
    expect(html).toContain(">yes<");
    expect(html).toContain(">no<");
  });

  it("disables the builder and shows a banner when the JSON is invalid", () => {
    const html = render({ content: "{ not valid json" });

    expect(html).toContain('data-testid="form-schema-invalid-banner"');
    expect(html).toContain(
      "The JSON is invalid — fix it to re-enable the builder.",
    );
    // no structured field rows when the builder is disabled
    expect(html).not.toContain('data-testid="form-schema-add-field"');
    // the raw JSON editor stays available so the user can fix it
    expect(html).toContain('data-testid="code-editor"');
  });

  it("shows an empty-state when the schema has no fields", () => {
    const html = render({
      content: JSON.stringify({ schemaVersion: 1, fields: [] }),
    });

    expect(html).toContain("No fields yet.");
  });

  it("marks every interactive control disabled in readOnly mode", () => {
    const html = render({ readOnly: true });

    // the add-field button is rendered but disabled
    expect(html).toMatch(/data-testid="form-schema-add-field"[^>]*disabled/);
  });
});
