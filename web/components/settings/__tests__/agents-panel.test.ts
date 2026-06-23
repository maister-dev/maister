// M34 (ADR-089 D11) — the /settings platform-agent catalog panel: view-only
// table, quarantine badge with the reason on hover, manual-launch affordance
// gated on enabled+unquarantined. renderToStaticMarkup — no jsdom (repo
// convention); next-intl/next-navigation mocked at the module boundary.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
  useTranslations: (namespace: string) => (key: string) =>
    `${namespace}.${key}`,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

import {
  AgentsPanel,
  type AgentSummaryRow,
} from "@/components/settings/agents-panel";

function agent(over: Partial<AgentSummaryRow> = {}): AgentSummaryRow {
  return {
    id: "aif:triager",
    packageName: "aif",
    versionLabel: "v1.2.0",
    origin: "git",
    name: "Triager",
    description: "classifies tasks",
    runnerId: null,
    workspace: "none",
    mode: "session",
    triggers: ["manual", "domain_event"],
    riskTier: "read_only",
    sourcePath: "/cache/aif@v1.2.0/agents/triager.md",
    enabled: true,
    quarantinedAt: null,
    quarantineReason: null,
    ...over,
  };
}

function render(agents: AgentSummaryRow[]): string {
  return renderToStaticMarkup(
    createElement(AgentsPanel, {
      agents,
      projects: [{ id: "p1", slug: "demo", name: "Demo" }],
    }),
  );
}

describe("AgentsPanel — catalog table (M34 D11)", () => {
  it("renders the row fields, package provenance, and the enabled chip", () => {
    const html = render([agent()]);

    expect(html).toContain("aif:triager");
    expect(html).toContain("aif@v1.2.0");
    expect(html).toContain("manual, domain_event");
    expect(html).toContain("read_only");
    expect(html).toContain("agents.enabled");
    expect(html).toContain("agents.resync");
    // ADR-089 rework: no create/edit surface — packages are the only path.
    expect(html).not.toContain("agents.addAgent");
    expect(html).not.toContain("agents.edit");
  });

  it("renders the quarantine badge + un-quarantine action and withholds Launch", () => {
    const html = render([
      agent({
        quarantinedAt: "2026-06-12T10:00:00.000Z",
        quarantineReason: "dirty repo_read workspace",
      }),
    ]);

    expect(html).toContain("agents.quarantined");
    expect(html).toContain("agents.unquarantine");
    expect(html).toContain("dirty repo_read workspace");
    // The Launch button renders disabled for a quarantined agent.
    expect(html).toMatch(/disabled=""[^>]*>\s*agents\.launch/);
  });

  it("renders the empty state without rows", () => {
    const html = render([]);

    expect(html).toContain("agents.empty");
  });
});
