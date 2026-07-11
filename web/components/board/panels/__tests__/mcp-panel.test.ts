import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
  usePathname: () => "/projects/x",
}));

import {
  McpPanel,
  type ProjectMcpRow,
} from "@/components/board/panels/mcp-panel";

const server: ProjectMcpRow = {
  id: "row-1",
  mcpId: "local-fs",
  transport: "stdio",
  command: "npx",
  args: [],
  envKeys: [],
  url: null,
  headerKeys: [],
  supportedAgents: ["claude"],
  enabled: true,
};

describe("McpPanel — requirements ledger (W-D)", () => {
  it("renders the requirements section with a classification per ref", () => {
    const markup = renderToStaticMarkup(
      createElement(McpPanel, {
        servers: [server],
        requirements: [
          { refId: "github", classification: "bound" },
          { refId: "postgres", classification: "unbound" },
          { refId: "serena", classification: "not_ready" },
        ],
        slug: "proj",
        isAdmin: true,
      }),
    );

    expect(markup).toContain('data-testid="mcp-requirements"');
    expect(markup).toContain('data-testid="mcp-req-github"');
    expect(markup).toContain('data-testid="mcp-req-postgres"');
    expect(markup).toContain("classification.bound");
    expect(markup).toContain("classification.unbound");
    expect(markup).toContain("classification.not_ready");
    // A bound ref exposes a Test-connection action; an unbound one does not.
    expect(markup).toContain("testConnection");
  });

  it("omits the requirements section when there are none", () => {
    const markup = renderToStaticMarkup(
      createElement(McpPanel, {
        servers: [server],
        requirements: [],
        slug: "proj",
        isAdmin: true,
      }),
    );

    expect(markup).not.toContain('data-testid="mcp-requirements"');
  });
});
