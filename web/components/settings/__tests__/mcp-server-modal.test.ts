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
  McpServerModal,
  type McpServerRow,
} from "@/components/settings/mcp-server-modal";

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
  enabled: true,
};

describe("McpServerModal", () => {
  it("renders the create form (stdio default) with id/command + agents", () => {
    const markup = renderToStaticMarkup(
      createElement(McpServerModal, {
        mode: "create",
        onClose() {},
        onSaved() {},
      }),
    );

    expect(markup).toContain("createMcpTitle");
    expect(markup).toContain("fieldMcpId");
    expect(markup).toContain("fieldTransport");
    // stdio default → command + envKeys fields, not url.
    expect(markup).toContain("fieldCommand");
    expect(markup).toContain("fieldEnvKeys");
    expect(markup).toContain("fieldSupportedAgents");
  });

  it("renders the edit form for an http server with url/headers + delete", () => {
    const markup = renderToStaticMarkup(
      createElement(McpServerModal, {
        mode: "edit",
        server: httpServer,
        onClose() {},
        onSaved() {},
      }),
    );

    expect(markup).toContain("editMcpTitle");
    expect(markup).toContain("deleteMcp");
    expect(markup).toContain("fieldUrl");
    expect(markup).toContain("fieldHeaderKeys");
    expect(markup).toContain("https://mcp.example.com/sse");
    expect(markup).toContain("remote");
  });
});
