import type { ResolvedCapabilitySet } from "@/lib/db/schema";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  ResolvedCapabilitySetPanel,
  type ResolvedCapabilitySetLabels,
} from "@/components/runs/resolved-capability-set-panel";

const labels: ResolvedCapabilitySetLabels = {
  title: "Resolved capability set",
  flowRevision: "Flow revision",
  flowOrigin: "Origin",
  capabilities: "Capabilities",
  mcps: "MCP servers",
  empty: "None",
  origin: { authored: "Authored", git: "Git" },
  withheld: "Withheld MCP servers",
  provenance: { binding: "bound", precedence: "precedence" },
  withheldReason: {
    "platform-untrusted": "platform untrusted",
    "exec-untrusted-stdio": "exec-untrusted stdio",
  },
};

function render(resolved: ResolvedCapabilitySet): string {
  return renderToStaticMarkup(
    createElement(ResolvedCapabilitySetPanel, { resolved, labels }),
  );
}

describe("ResolvedCapabilitySetPanel", () => {
  it("renders the flow revision, origin, and each capability + mcp from the snapshot", () => {
    const html = render({
      flowRevisionId: "rev-abc123",
      flowOrigin: "authored",
      capabilities: [
        { refId: "lint", kind: "skill", sha: "deadbeef", scope: "project" },
        { refId: "no-secrets", kind: "rule", sha: null, scope: "flow-package" },
      ],
      mcps: [{ refId: "github", sha: "cafef00d", scope: "project" }],
    });

    expect(html).toContain('data-testid="resolved-capability-set"');
    expect(html).toContain("rev-abc123");
    expect(html).toContain("Authored");
    expect(html).toContain('data-testid="resolved-cap-lint"');
    expect(html).toContain('data-testid="resolved-cap-no-secrets"');
    expect(html).toContain("deadbeef");
    expect(html).toContain('data-testid="resolved-mcp-github"');
    expect(html).toContain("project");
  });

  it("renders mcp provenance and the withheld section (W-E)", () => {
    const html = render({
      flowRevisionId: "rev-w",
      flowOrigin: "git",
      capabilities: [],
      mcps: [
        {
          refId: "github",
          sha: "s",
          scope: "platform",
          provenance: "binding",
        },
      ],
      withheldMcps: [
        {
          refId: "serena",
          transport: "stdio",
          reason: "platform-untrusted",
          scope: "platform",
        },
      ],
    });

    expect(html).toContain('data-testid="resolved-mcp-prov-github"');
    expect(html).toContain("bound");
    expect(html).toContain("Withheld MCP servers");
    expect(html).toContain('data-testid="withheld-mcp-serena"');
    expect(html).toContain("platform untrusted");
  });

  it("shows the empty label when there are no capabilities or mcps", () => {
    const html = render({
      flowRevisionId: "rev-empty",
      flowOrigin: "git",
      capabilities: [],
      mcps: [],
    });

    expect(html).toContain("Git");
    expect(html).toContain("None");
    expect(html).not.toContain('data-testid="resolved-cap-');
    expect(html).not.toContain('data-testid="resolved-mcp-');
  });
});
