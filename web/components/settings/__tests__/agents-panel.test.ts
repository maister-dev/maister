// M33 (ADR-088 D11) — the /settings platform-agent catalog panel: view-only
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
    id: "triager",
    scope: "platform",
    projectId: null,
    name: "Triager",
    description: "classifies tasks",
    runnerId: null,
    workspace: "none",
    mode: "session",
    triggers: ["manual", "domain_event"],
    riskTier: "read_only",
    sourcePath: "/agents/triager/agent.md",
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
      runners: [{ id: "runner-1" }],
      projects: [{ id: "p1", slug: "demo", name: "Demo" }],
    }),
  );
}

describe("AgentsPanel — catalog table (M33 D11)", () => {
  it("renders the row fields and the enabled state chip", () => {
    const html = render([agent()]);

    expect(html).toContain("triager");
    expect(html).toContain("platform");
    expect(html).toContain("manual, domain_event");
    expect(html).toContain("read_only");
    expect(html).toContain("agents.enabled");
    expect(html).toContain("agents.resync");
    expect(html).toContain("agents.addAgent");
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
