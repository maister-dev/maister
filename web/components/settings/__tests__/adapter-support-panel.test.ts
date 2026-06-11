import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { AdapterSupportPanel } from "@/components/settings/adapter-support-panel";
import { getAdapterSupport } from "@/lib/acp-runners/schema";

vi.mock("next-intl/server", () => ({
  getTranslations: async () => (key: string) => key,
}));

describe("AdapterSupportPanel", () => {
  it("renders supervisor diagnostics binary readiness and runner usage", async () => {
    const element = await AdapterSupportPanel({
      adapters: getAdapterSupport().filter((adapter) =>
        ["claude", "codex"].includes(adapter.id),
      ),
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
              source: "path",
              path: "/usr/local/bin/claude-agent-acp",
              available: true,
              version: null,
              error: null,
              smoke: {
                status: "not_required",
                reason: null,
                checkedAt: null,
                protocolVersion: null,
              },
            },
            {
              id: "codex",
              binary: "codex-acp",
              source: "path",
              path: null,
              available: false,
              version: null,
              error: "not found",
              smoke: {
                status: "not_required",
                reason: null,
                checkedAt: null,
                protocolVersion: null,
              },
            },
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
      adapters: getAdapterSupport().filter(
        (adapter) => adapter.id === "claude",
      ),
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
