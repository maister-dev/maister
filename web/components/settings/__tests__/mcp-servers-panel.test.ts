import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
  usePathname: () => "/settings",
}));

import {
  McpServersPanel,
  type McpServerRow,
} from "@/components/settings/mcp-servers-panel";

const stdioServer: McpServerRow = {
  id: "github",
  transport: "stdio",
  command: "github-mcp",
  args: [],
  description: null,
  env: { GITHUB_TOKEN: "env:GITHUB_TOKEN" },
  url: null,
  headers: {},
  bearerTokenEnv: null,
  supportedAgents: ["claude", "codex"],
  trustStatus: "untrusted",
  readinessStatus: "NotReady",
  readinessReasons: ["env ref missing: GITHUB_TOKEN"],
  enabled: true,
};

const httpServer: McpServerRow = {
  id: "remote",
  transport: "http",
  command: null,
  args: [],
  description: null,
  env: {},
  url: "https://mcp.example.com/sse",
  headers: { "X-Api-Key": "env:MCP_AUTH" },
  bearerTokenEnv: null,
  supportedAgents: ["claude"],
  trustStatus: "untrusted",
  readinessStatus: "Unknown",
  readinessReasons: [],
  enabled: false,
};

describe("McpServersPanel", () => {
  it("renders the MCP table with an add action and per-server rows", () => {
    const markup = renderToStaticMarkup(
      createElement(McpServersPanel, { servers: [stdioServer, httpServer] }),
    );

    expect(markup).toContain("mcpServersTitle");
    expect(markup).toContain("addMcp");
    expect(markup).toContain("colTransport");
    expect(markup).toContain("colTarget");
    expect(markup).toContain("colAgents");
    expect(markup).toContain("github");
    expect(markup).toContain("github-mcp");
    expect(markup).toContain("remote");
    // The http target column shows the URL, not a command.
    expect(markup).toContain("https://mcp.example.com/sse");
    // ADR-129 (W-D/W-E): trust action + used-by columns.
    expect(markup).toContain("colTrust");
    expect(markup).toContain("colUsedBy");
    expect(markup).toContain("needsTrust"); // both seeded servers are untrusted
    expect(markup).toContain("trustAction");
  });

  it("renders the empty state when there are no servers", () => {
    const markup = renderToStaticMarkup(
      createElement(McpServersPanel, { servers: [] }),
    );

    expect(markup).toContain("mcpEmpty");
  });
});

// ADR-177 (D19): the reason travels to the operator, not just to the column.
describe("readiness reasons", () => {
  it("renders the reasons as the status chip's tooltip", () => {
    const markup = renderToStaticMarkup(
      createElement(McpServersPanel, {
        servers: [stdioServer],
        isAdmin: true,
      } as never),
    );

    expect(markup).toContain("env ref missing: GITHUB_TOKEN");
  });

  it("falls back to the status when there is no reason", () => {
    const markup = renderToStaticMarkup(
      createElement(McpServersPanel, {
        servers: [httpServer],
        isAdmin: true,
      } as never),
    );

    expect(markup).toContain('title="Unknown"');
  });
});
