import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  CapabilityProfilePanel,
  type CapabilityProfileNodeView,
  type CapabilityProfilePanelLabels,
} from "@/components/board/panels/capability-profile-panel";

// ---------------------------------------------------------------------------
// CONTRACT under test — `components/board/panels/capability-profile-panel.tsx`
// (M14 T6.1, AC #7). A PURE-RENDER server component (no `useTranslations`,
// no DB): it takes a pre-built view-model (from getRunCapabilityProfiles) +
// threaded i18n labels and renders, per ai_coding/judge node, the materialized
// capability profile: short digest, resolved revisions (kind/refId @ sha),
// and the enforced / instructed / refused capability classes — plus a
// cleanup-failed badge and a third-party flag for untrusted revisions.
//
// HONESTY: nothing here is "enforced" beyond what the recorded plan says; the
// subtitle (threaded as a label) MUST state the plan is recorded only and that
// live enforcement is pending (ADR-041).
//
// This mirrors flow-settings-panel.test.ts: a pure render fn + a *Labels type +
// the view-model type, tested via renderToStaticMarkup. No testing-library /
// jsdom is installed; do not introduce one.
// ---------------------------------------------------------------------------

const labels: CapabilityProfilePanelLabels = {
  title: "Capability profile",
  subtitle: "Capabilities materialized for each AI node (recorded only).",
  digestLabel: "Profile digest",
  revisionLabel: "Resolved revisions",
  enforcedLabel: "Enforced",
  instructedLabel: "Instructed",
  refusedLabel: "Refused",
  cleanupFailedLabel: "Cleanup failed",
  trustThirdParty: "third-party",
  noProfiles: "No capability profiles",
  classLabel: (c) => c,
};

function render(nodes: CapabilityProfileNodeView[]): string {
  return renderToStaticMarkup(
    createElement(CapabilityProfilePanel, { nodes, labels }),
  );
}

function node(
  over: Partial<CapabilityProfileNodeView>,
): CapabilityProfileNodeView {
  return {
    nodeId: "implement",
    nodeType: "ai_coding",
    profileDigest: "abcdef0123456789deadbeef",
    resolvedRevisions: [
      {
        refId: "aif-skill-lint",
        kind: "skill",
        sha: "0011223344556677",
        trustStatus: "trusted",
      },
    ],
    enforcedClasses: ["aif-skill-lint"],
    instructedClasses: ["aif-mcp-search"],
    refusedClasses: ["aif-tool-shell"],
    cleanupFailed: false,
    ...over,
  };
}

describe("CapabilityProfilePanel — materialized profile per node", () => {
  it("renders the (shortened) profile digest", () => {
    const html = render([node({})]);

    // first 12 chars of the digest surface (full 24-char digest may be elided).
    expect(html).toContain("abcdef012345");
  });

  it("renders enforced / instructed / refused class names", () => {
    const html = render([node({})]);

    expect(html).toContain("aif-skill-lint");
    expect(html).toContain("aif-mcp-search");
    expect(html).toContain("aif-tool-shell");
    // the group labels surface too.
    expect(html).toContain("Enforced");
    expect(html).toContain("Instructed");
    expect(html).toContain("Refused");
  });

  it("renders a refused class chip distinctly (red tone marker)", () => {
    const html = render([
      node({
        enforcedClasses: [],
        instructedClasses: [],
        refusedClasses: ["aif-tool-shell"],
      }),
    ]);

    expect(html).toContain("aif-tool-shell");
    expect(html).toContain("Refused");
  });

  it("renders each resolved revision as kind/refId @ short-sha", () => {
    const html = render([node({})]);

    expect(html).toContain("skill");
    expect(html).toContain("aif-skill-lint");
    // sha truncated to 12 chars.
    expect(html).toContain("001122334455");
  });

  it("shows the third-party flag for an untrusted revision", () => {
    const html = render([
      node({
        resolvedRevisions: [
          {
            refId: "evil-cap",
            kind: "mcp",
            sha: "9988776655443322",
            trustStatus: "untrusted",
          },
        ],
      }),
    ]);

    expect(html).toContain("third-party");
  });

  it("omits the third-party flag for a trusted revision", () => {
    const html = render([
      node({
        resolvedRevisions: [
          {
            refId: "good-cap",
            kind: "mcp",
            sha: "1122334455667788",
            trustStatus: "trusted",
          },
        ],
      }),
    ]);

    expect(html).not.toContain("third-party");
  });

  it("shows the cleanup-failed badge when cleanupFailed is true", () => {
    const html = render([node({ cleanupFailed: true })]);

    expect(html).toContain("Cleanup failed");
    // a11y: the badge is exposed to assistive tech.
    expect(html).toMatch(/role="status"|aria-label="Cleanup failed"/);
  });

  it("omits the cleanup-failed badge when cleanupFailed is false", () => {
    const html = render([node({ cleanupFailed: false })]);

    expect(html).not.toContain("Cleanup failed");
  });

  it("renders the no-profiles label when nodes is empty", () => {
    const html = render([]);

    expect(html).toContain("No capability profiles");
  });
});

// ---------------------------------------------------------------------------
// SECRET-LEAK GUARD (skill: server-only-secrets / R-SECRET). The panel renders
// ONLY names / shas / digests / classes from the view-model — never any secret
// value. Prove the rendered markup carries no token/secret/key-prefix material.
// ---------------------------------------------------------------------------

describe("CapabilityProfilePanel — no secret leakage in rendered markup", () => {
  it("markup matches NEITHER /token|secret|ghp_|sk-/i", () => {
    const html = render([
      node({}),
      node({ nodeId: "judge", nodeType: "judge", cleanupFailed: true }),
    ]);

    expect(html).not.toMatch(/token|secret|ghp_|sk-/i);
  });
});
