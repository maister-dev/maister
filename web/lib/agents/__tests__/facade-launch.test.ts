import { existsSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveFacadeLaunch } from "@/lib/agents/facade-launch";

vi.mock("node:fs", () => ({ existsSync: vi.fn(() => false) }));

const existsMock = vi.mocked(existsSync);

describe("resolveFacadeLaunch", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    existsMock.mockReset();
    existsMock.mockReturnValue(false);
  });

  it("uses the env override with default --stdio args", () => {
    vi.stubEnv("MAISTER_MCP_FACADE_COMMAND", "/usr/local/bin/maister-mcp");

    expect(resolveFacadeLaunch()).toEqual({
      command: "/usr/local/bin/maister-mcp",
      args: ["--stdio"],
    });
  });

  it("splits explicit override args", () => {
    vi.stubEnv("MAISTER_MCP_FACADE_COMMAND", "node");
    vi.stubEnv("MAISTER_MCP_FACADE_ARGS", "/opt/mcp/main.js --stdio");

    expect(resolveFacadeLaunch()).toEqual({
      command: "node",
      args: ["/opt/mcp/main.js", "--stdio"],
    });
  });

  it("prefers the built bundle run by the current node when dist exists", () => {
    existsMock.mockImplementation((p) => String(p).endsWith("/dist/main.js"));

    const res = resolveFacadeLaunch();

    expect(res?.command).toBe(process.execPath);
    expect(res?.args[0]).toMatch(/mcp\/dist\/main\.js$/);
    expect(res?.args[1]).toBe("--stdio");
  });

  it("returns null when no override, no built bundle, and no tsx", () => {
    existsMock.mockReturnValue(false);

    expect(resolveFacadeLaunch()).toBeNull();
  });

  it("keeps the local facade override when the same Web process also routes to a remote supervisor", () => {
    vi.stubEnv(
      "MAISTER_ADDITIONAL_EXECUTION_HOSTS",
      '[{"hostKey":"eh_supervisor_b","url":"https://supervisor-b.example.invalid"}]',
    );
    vi.stubEnv("MAISTER_MCP_FACADE_COMMAND", "/usr/local/bin/maister-mcp");

    expect(resolveFacadeLaunch()).toEqual({
      command: "/usr/local/bin/maister-mcp",
      args: ["--stdio"],
    });
  });
});
