import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { AdapterSupportPanel } from "@/components/settings/adapter-support-panel";

vi.mock("next-intl/server", () => ({
  getTranslations: async () => (key: string) => key,
}));

describe("AdapterSupportPanel", () => {
  it("renders supervisor diagnostics binary readiness and runner usage", async () => {
    const element = await AdapterSupportPanel({
      adapters: [
        {
          id: "claude",
          capabilityAgent: "claude",
          providerKinds: ["anthropic"],
          permissionPolicies: ["default", "dangerously_skip_permissions"],
        },
        {
          id: "codex",
          capabilityAgent: "codex",
          providerKinds: ["openai"],
          permissionPolicies: ["default"],
        },
      ],
      diagnostics: {
        kind: "ready",
        diagnostics: {
          status: "ready",
          version: "0.0.1",
          checkedAt: "2026-06-03T12:00:00.000Z",
          adapters: [
            {
              id: "claude",
              binary: "claude-agent-acp",
              available: true,
            },
            { id: "codex", binary: "codex-acp", available: false },
          ],
          sidecars: [],
          envRefs: [],
        },
      },
      runners: [{ id: "claude-default", adapter: "claude" }],
    });

    const html = renderToStaticMarkup(element);

    expect(html).toContain("claude-agent-acp");
    expect(html).toContain("available");
    expect(html).toContain("codex-acp");
    expect(html).toContain("unavailable");
    expect(html).toContain("claude-default");
  });

  it("renders diagnostics unavailable without leaking messages", async () => {
    const element = await AdapterSupportPanel({
      adapters: [
        {
          id: "claude",
          capabilityAgent: "claude",
          providerKinds: ["anthropic"],
          permissionPolicies: ["default"],
        },
      ],
      diagnostics: {
        kind: "unavailable",
        reason: "network",
        message: "secret-like diagnostic detail",
      },
      runners: [],
    });

    const html = renderToStaticMarkup(element);

    expect(html).toContain("diagnosticsUnavailable: network");
    expect(html).not.toContain("secret-like diagnostic detail");
  });
});
