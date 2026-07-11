import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PackageViewerHeader } from "@/components/flows/package-viewer";

const labels = {
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
  incompatibleRemediation:
    "Republish the package with a non-empty nodes[] graph.",
};

function render(incompatibilityMessage: string | null): string {
  return renderToStaticMarkup(
    createElement(PackageViewerHeader, {
      flowRef: "legacy-flow",
      versionLabel: "v1.0.0",
      resolvedRevision: "1234567890abcdef",
      enablementState: "Installed",
      trustStatus: "trusted",
      execTrust: "trusted",
      labels,
      incompatibilityMessage,
    }),
  );
}

describe("PackageViewerHeader incompatibility state", () => {
  it("renders an accessible engine-3 badge and remediation for a legacy revision", () => {
    const html = render("legacy steps[]");

    expect(html).toContain('data-testid="package-incompatible-badge"');
    expect(html).toContain("Incompatible with engine 3.0.0");
    expect(html).toContain('role="alert"');
    expect(html).toContain(
      "Republish the package with a non-empty nodes[] graph.",
    );
  });

  it("keeps a compatible revision free of the refusal alert", () => {
    const html = render(null);

    expect(html).not.toContain("package-incompatible-badge");
    expect(html).not.toContain('role="alert"');
  });
});
