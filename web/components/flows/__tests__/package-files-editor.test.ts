import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PackageFilesEditor } from "@/components/flows/package-files-editor";

const KIND_LABELS = {
  asset: "Asset",
  agent_definition: "Agent definition",
  readme: "README",
  rule: "Rule",
  schema: "Schema",
  script: "Script",
  setup: "Setup",
  skill: "Skill",
  template: "Template",
};

const LABELS = {
  addFile: "Add file",
  content: "Content",
  kind: "Kind",
  path: "Path",
  removeFile: "Remove",
};

describe("PackageFilesEditor", () => {
  it("renders typed package file controls and keeps the JSON server-action field hidden", () => {
    const html = renderToStaticMarkup(
      createElement(PackageFilesEditor, {
        disabled: false,
        files: [
          {
            kind: "script",
            path: "scripts/setup.sh",
            content: "#!/usr/bin/env bash\n",
          },
        ],
        kindLabels: KIND_LABELS,
        labels: LABELS,
      }),
    );

    expect(html).toContain('name="packageFilesJson"');
    expect(html).toContain('type="hidden"');
    expect(html).toContain("<select");
    expect(html).toContain("scripts/setup.sh");
    expect(html).toContain("Add file");
    expect(html).toContain("Remove");
  });

  it("renders viewers as read-only inspectors", () => {
    const html = renderToStaticMarkup(
      createElement(PackageFilesEditor, {
        disabled: true,
        files: [{ kind: "readme", path: "README.md", content: "Hello" }],
        kindLabels: KIND_LABELS,
        labels: LABELS,
      }),
    );

    expect(html).toContain("README.md");
    expect(html).toContain("disabled");
    expect(html).not.toContain("Add file");
    expect(html).not.toContain("Remove");
  });
});
