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
  envKeys: ["GITHUB_TOKEN"],
  url: null,
  headerKeys: [],
  supportedAgents: ["claude", "codex"],
  trustStatus: "untrusted",
  readinessStatus: "Unknown",
  enabled: true,
};

const httpServer: McpServerRow = {
  id: "remote",
  transport: "http",
  command: null,
  args: [],
  envKeys: [],
  url: "https://mcp.example.com/sse",
  headerKeys: ["MCP_AUTH"],
  supportedAgents: ["claude"],
  trustStatus: "untrusted",
  readinessStatus: "Unknown",
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
  });

  it("renders the empty state when there are no servers", () => {
    const markup = renderToStaticMarkup(
      createElement(McpServersPanel, { servers: [] }),
    );

    expect(markup).toContain("mcpEmpty");
  });
});
