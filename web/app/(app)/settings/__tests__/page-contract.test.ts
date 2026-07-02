import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getSessionUserMock = vi.hoisted(() => vi.fn());
const getDbMock = vi.hoisted(() => vi.fn());
const hostToolStatusMock = vi.hoisted(() => vi.fn());
const checkSupervisorDiagnosticsMock = vi.hoisted(() => vi.fn());
const mcpServersPanelMock = vi.hoisted(() => vi.fn(() => null));
const selectedTables = vi.hoisted(() => [] as unknown[]);
const schemaTables = vi.hoisted(() => ({
  platformAcpRunners: { name: "platform_acp_runners" },
  platformMcpServers: { name: "platform_mcp_servers" },
  platformRouterSidecars: { name: "platform_router_sidecars" },
  platformRuntimeSettings: { name: "platform_runtime_settings" },
}));

vi.mock("next-intl/server", () => ({
  getTranslations: async () => (key: string) => translate(key),
}));

vi.mock("@/lib/authz", () => ({
  getSessionUser: getSessionUserMock,
}));

vi.mock("@/lib/db/client", () => ({
  getDb: getDbMock,
}));

vi.mock("@/lib/db/schema", () => schemaTables);

vi.mock("@/lib/instance-config", () => ({
  hostToolStatus: hostToolStatusMock,
  reposRoot: () => "/repos",
  worktreesRoot: () => "/worktrees",
}));

vi.mock("@/lib/supervisor-client", () => ({
  checkSupervisorDiagnostics: checkSupervisorDiagnosticsMock,
}));

// The admin branch renders heavy client panels; stub them so this test asserts
// the authorization gate, not panel internals.
vi.mock("@/components/settings/acp-runners-panel", () => ({
  AcpRunnersPanel: () => null,
}));
vi.mock("@/components/settings/agents-panel", () => ({
  AgentsPanel: () => null,
}));
vi.mock("@/components/settings/adapter-support-panel", () => ({
  AdapterSupportPanel: () => null,
}));
vi.mock("@/components/settings/mcp-servers-panel", () => ({
  McpServersPanel: mcpServersPanelMock,
}));
vi.mock("@/components/settings/brain-settings-panel", () => ({
  BrainSettingsPanel: () => null,
}));
vi.mock("@/components/settings/router-sidecars-panel", () => ({
  RouterSidecarsPanel: () => null,
}));
vi.mock("@/components/settings/webhooks-panel", () => ({
  WebhooksPanel: () => null,
}));

const FORBIDDEN = "Access restricted to admins";
const ADMIN_ONLY_LABEL = "Repo home";

describe("SettingsPage authorization contract", () => {
  beforeEach(() => {
    getSessionUserMock.mockReset();
    getDbMock.mockReset();
    hostToolStatusMock.mockReset();
    checkSupervisorDiagnosticsMock.mockReset();
    mcpServersPanelMock.mockClear();
    selectedTables.length = 0;
    hostToolStatusMock.mockResolvedValue([]);
    checkSupervisorDiagnosticsMock.mockResolvedValue(null);
    getDbMock.mockReturnValue({
      select: () => ({
        from: (table: unknown) => {
          selectedTables.push(table);

          return Promise.resolve([]);
        },
      }),
      // ADR-122: loadPlatformRuntimeView also reads the brain settings via a
      // raw execute — empty rows = unconfigured Brain.
      execute: async () => ({ rows: [] }),
    });
  });

  it("renders the forbidden panel and loads NO admin data for a non-admin", async () => {
    getSessionUserMock.mockResolvedValue({ id: "u1", role: "member" });

    const { default: SettingsPage } = await import("../page");
    const html = renderToStaticMarkup(await SettingsPage());

    expect(html).toContain(FORBIDDEN);
    expect(html).not.toContain(ADMIN_ONLY_LABEL);

    // The security contract: a non-admin triggers none of the admin loaders.
    expect(getDbMock).not.toHaveBeenCalled();
    expect(hostToolStatusMock).not.toHaveBeenCalled();
    expect(checkSupervisorDiagnosticsMock).not.toHaveBeenCalled();
  });

  it("renders admin content and loads admin data for an admin", async () => {
    getSessionUserMock.mockResolvedValue({ id: "u2", role: "admin" });

    const { default: SettingsPage } = await import("../page");
    const html = renderToStaticMarkup(await SettingsPage());

    expect(html).not.toContain(FORBIDDEN);
    expect(html).toContain(ADMIN_ONLY_LABEL);

    expect(getDbMock).toHaveBeenCalled();
    expect(hostToolStatusMock).toHaveBeenCalled();
    expect(checkSupervisorDiagnosticsMock).toHaveBeenCalled();
    expect(mcpServersPanelMock).not.toHaveBeenCalled();
    expect(selectedTables).not.toContain(schemaTables.platformMcpServers);
  });
});

function translate(key: string): string {
  const messages: Record<string, string> = {
    forbidden: FORBIDDEN,
    repoHome: ADMIN_ONLY_LABEL,
  };

  return messages[key] ?? key;
}
