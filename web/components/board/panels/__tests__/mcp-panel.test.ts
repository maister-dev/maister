import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
  useTranslations:
    () =>
    (key: string, vars?: Record<string, unknown>): string =>
      vars ? `${key}:${JSON.stringify(vars)}` : key,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
  usePathname: () => "/projects/x",
}));

import {
  McpPanel,
  type HubServerView,
} from "@/components/board/panels/mcp-panel";

const platformServer: HubServerView = {
  refId: "github",
  source: "platform",
  transport: "stdio",
  enabled: true,
  trust: "trusted",
  readiness: "ready",
  usedByCount: 2,
  boundByRefs: ["github"],
  lastProbeStatus: "ok",
};

describe("McpPanel — requirements ledger + 3-source servers (W-D)", () => {
  it("renders the requirements section with classification + required tag per ref", () => {
    const markup = renderToStaticMarkup(
      createElement(McpPanel, {
        slug: "proj",
        isAdmin: true,
        servers: [platformServer],
        requirements: [
          {
            refId: "github",
            required: true,
            declaredBy: ["package:x"],
            classification: "bound",
          },
          {
            refId: "postgres",
            required: false,
            declaredBy: [],
            classification: "unbound",
          },
        ],
      }),
    );

    expect(markup).toContain('data-testid="mcp-requirements"');
    expect(markup).toContain('data-testid="mcp-req-github"');
    expect(markup).toContain('data-testid="mcp-req-postgres"');
    expect(markup).toContain("classification.bound");
    expect(markup).toContain("classification.unbound");
    expect(markup).toContain("requiredTag");
    expect(markup).toContain("optionalTag");
    // A bound ref (with an enabled binding source) exposes probe; an unbound one
    // exposes the bind action.
    expect(markup).toContain("testConnection");
    expect(markup).toContain("bind");
  });

  it("renders the 3-source servers overview with source + trust columns", () => {
    const markup = renderToStaticMarkup(
      createElement(McpPanel, {
        slug: "proj",
        isAdmin: true,
        requirements: [],
        servers: [platformServer],
      }),
    );

    expect(markup).toContain('data-testid="mcp-server-github"');
    expect(markup).toContain("sourcePlatform");
    expect(markup).toContain("colTrust");
    // A platform row can be disconnected.
    expect(markup).toContain("disconnect");
  });

  it("omits the requirements section when there are none", () => {
    const markup = renderToStaticMarkup(
      createElement(McpPanel, {
        slug: "proj",
        isAdmin: true,
        requirements: [],
        servers: [platformServer],
      }),
    );

    expect(markup).not.toContain('data-testid="mcp-requirements"');
  });

  it("shows the admin-only notice and no servers table for a non-admin", () => {
    const markup = renderToStaticMarkup(
      createElement(McpPanel, {
        slug: "proj",
        isAdmin: false,
        requirements: [],
        servers: [],
      }),
    );

    expect(markup).toContain("adminOnly");
    expect(markup).not.toContain('data-testid="mcp-server-github"');
  });
});
