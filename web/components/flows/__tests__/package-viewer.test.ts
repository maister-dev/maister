import type { FlowManifestIncompatibility } from "@/lib/flows/manifest-parser";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  PackageViewerHeader,
  type PackageViewerHeaderLabels,
} from "@/components/flows/package-viewer";

const labels: PackageViewerHeaderLabels = {
  versionLabel: "Version",
  resolvedRevision: "Revision",
  enablement: "State",
  trust: "Trust",
  execTrust: "Executable trust",
  trustUntrusted: "Untrusted",
  trustTrusted: "Trusted",
  trustTrustedByPolicy: "Trusted by policy",
  execUntrusted: "Scripts blocked",
  execTrusted: "Scripts allowed",
  incompatible: "Incompatible with engine 3.0.0",
  incompatibleLegacyRemediation:
    "Republish the package with a non-empty nodes[] graph.",
  incompatibleEngineRemediation:
    "Use a package version compatible with engine 3.0.0.",
  incompatibleInvalidRemediation:
    "Fix the invalid package manifest and republish it.",
};

function render(incompatibility: FlowManifestIncompatibility | null): string {
  return renderToStaticMarkup(
    createElement(PackageViewerHeader, {
      flowRef: "legacy-flow",
      versionLabel: "v1.0.0",
      resolvedRevision: "1234567890abcdef",
      enablementState: "Installed",
      trustStatus: "trusted",
      execTrust: "trusted",
      labels,
      incompatibility,
    }),
  );
}

describe("PackageViewerHeader incompatibility state", () => {
  it("renders an accessible engine-3 badge and remediation for a legacy revision", () => {
    const html = render({
      kind: "legacy_steps",
      message: "legacy steps[] flows are unsupported",
    });

    expect(html).toContain('data-testid="package-incompatible-badge"');
    expect(html).toContain("Incompatible with engine 3.0.0");
    expect(html).toContain('role="alert"');
    expect(html).toContain(
      "Republish the package with a non-empty nodes[] graph.",
    );
  });

  it("uses engine-specific remediation without claiming that nodes[] is missing", () => {
    const html = render({
      kind: "engine_incompatible",
      message: "engine 3.0.0 < engine_min 4.0.0",
    });

    expect(html).toContain(
      "Use a package version compatible with engine 3.0.0.",
    );
    expect(html).toContain("engine 3.0.0 &lt; engine_min 4.0.0");
    expect(html).not.toContain(
      "Republish the package with a non-empty nodes[] graph.",
    );
  });

  it("uses an invalid-manifest remediation without prescribing a graph conversion", () => {
    const html = render({
      kind: "invalid_manifest",
      message: "nodes.0.id: Required",
    });

    expect(html).toContain(
      "Fix the invalid package manifest and republish it.",
    );
    expect(html).not.toContain(
      "Republish the package with a non-empty nodes[] graph.",
    );
  });

  it("keeps a compatible revision free of the refusal alert", () => {
    const html = render(null);

    expect(html).not.toContain("package-incompatible-badge");
    expect(html).not.toContain('role="alert"');
  });
});
