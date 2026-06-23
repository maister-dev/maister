import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PackageManifestForm } from "@/components/studio/package-manifest-form";

const LABELS = {
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
  parseError: "The manifest could not be parsed",
  empty: "None",
};

const VALID = `schemaVersion: 1
name: my-pkg
metadata:
  title: My Package
  summary: Does things
flows:
  - id: bugfix
    path: flows/bugfix
`;

describe("PackageManifestForm", () => {
  it("renders the scalar fields + entry summaries from a valid manifest", () => {
    const html = renderToStaticMarkup(
      createElement(PackageManifestForm, {
        content: VALID,
        readOnly: false,
        labels: LABELS,
        onChange: () => {},
      }),
    );

    expect(html).toContain('data-testid="package-manifest-form"');
    expect(html).toContain('data-testid="manifest-field-name"');
    expect(html).toContain("my-pkg");
    expect(html).toContain("My Package");
    expect(html).toContain("bugfix");
    // a valid, complete manifest → no parse error, no validation issues
    expect(html).not.toContain('data-testid="manifest-parse-error"');
    expect(html).not.toContain('data-testid="manifest-issues"');
  });

  it("falls back to a parse-error notice for unparseable YAML", () => {
    const html = renderToStaticMarkup(
      createElement(PackageManifestForm, {
        content: ":\n  - [",
        readOnly: false,
        labels: LABELS,
        onChange: () => {},
      }),
    );

    expect(html).toContain('data-testid="manifest-parse-error"');
    // the form fields are NOT rendered when the manifest cannot be parsed
    expect(html).not.toContain('data-testid="manifest-field-name"');
  });

  it("surfaces schema validation issues for an invalid manifest (bad name)", () => {
    // Empty flows are valid now (ADR-105); an unsafe `name` (spaces/punctuation)
    // still violates capabilityRefIdSchema → the issues panel renders.
    const html = renderToStaticMarkup(
      createElement(PackageManifestForm, {
        content: "schemaVersion: 1\nname: Bad Name!\nflows: []\n",
        readOnly: false,
        labels: LABELS,
        onChange: () => {},
      }),
    );

    expect(html).toContain('data-testid="manifest-issues"');
  });
});
