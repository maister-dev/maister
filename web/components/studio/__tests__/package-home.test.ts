import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PackageHome } from "@/components/studio/package-home";
import {
  packageFileKindLabels,
  packageFilesEditorLabels,
} from "@/lib/flows/editor/editor-labels";

// Identity translator — render assertions don't depend on copy, only structure.
const t = (key: string): string => key;
const FILES_LABELS = packageFilesEditorLabels(t, t, true);
const KIND_LABELS = packageFileKindLabels(t);
const HOME_LABELS = {
  orientation: "Package home",
  flowsHeading: "Flows",
  noFlows: "No flows yet.",
  save: "Save changes",
};

const VALID_MANIFEST = `schemaVersion: 1
name: my-pkg
flows:
  - id: bugfix
    path: flows/bugfix
`;

describe("PackageHome", () => {
  it("lands on the manifest form, links flows to the canvas, and shows no flow-canvas banner", () => {
    const html = renderToStaticMarkup(
      createElement(PackageHome, {
        packageId: "pkg1",
        name: "My Package",
        files: [
          {
            kind: "manifest",
            path: "maister-package.yaml",
            content: VALID_MANIFEST,
          },
          {
            kind: "asset",
            path: "flows/bugfix/flow.yaml",
            content: "name: f\n",
          },
        ],
        readOnly: false,
        labels: HOME_LABELS,
        filesLabels: FILES_LABELS,
        fileKindLabels: KIND_LABELS,
        mcpCatalog: [],
        saveAction: () => {},
      }),
    );

    expect(html).toContain('data-testid="package-home"');
    // the flow is reachable on the canvas via a link (not an empty canvas)
    expect(html).toContain('data-testid="package-home-flow-link"');
    expect(html).toContain("/studio/edit/pkg1/flows/bugfix/flow.yaml");
    // the manifest form is the default landing surface
    expect(html).toContain('data-testid="package-manifest-form"');
    // the bug being fixed: no empty-canvas "YAML is invalid" sync banner here
    expect(html).not.toContain("flow-yaml-sync-error");
    // the working-dir save contract is intact
    expect(html).toContain('name="packageFilesJson"');
    expect(html).toContain('data-testid="package-home-save"');
  });

  it("renders read-only without the save button", () => {
    const html = renderToStaticMarkup(
      createElement(PackageHome, {
        packageId: "pkg1",
        name: "My Package",
        files: [
          {
            kind: "manifest",
            path: "maister-package.yaml",
            content: VALID_MANIFEST,
          },
        ],
        readOnly: true,
        labels: HOME_LABELS,
        filesLabels: FILES_LABELS,
        fileKindLabels: KIND_LABELS,
        mcpCatalog: [],
        saveAction: () => {},
      }),
    );

    expect(html).toContain('data-testid="package-home"');
    expect(html).not.toContain('data-testid="package-home-save"');
  });
});
