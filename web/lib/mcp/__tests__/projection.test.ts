import type { PlatformMcpServer } from "@/lib/db/schema";

import { describe, expect, it } from "vitest";

import { platformMcpRowToCapability } from "@/lib/mcp/projection";

function row(overrides: Partial<PlatformMcpServer>): PlatformMcpServer {
  return {
    id: "github",
    transport: "stdio",
    command: "github-mcp",
    args: ["--flag"],
    envKeys: ["env:GITHUB_TOKEN"],
    url: null,
    headerKeys: [],
    supportedAgents: ["claude", "codex"],
    trustStatus: "untrusted",
    readinessStatus: "Unknown",
    readinessReasons: [],
    enabled: true,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  } as PlatformMcpServer;
}

describe("platformMcpRowToCapability (T-C3)", () => {
  it("maps a stdio row to a default-selected platform mcp capability", () => {
    const cap = platformMcpRowToCapability(row({}));

    expect(cap).toMatchObject({
      id: "github",
      kind: "mcp",
      label: "github",
      source: "platform",
      command: "github-mcp",
      args: ["--flag"],
      enforceability: "enforced",
      selected_by_default: true,
    });
    expect(cap.agents).toEqual(["claude", "codex"]);
  });

  it("projects env NAME references as an env:NAME map (never plaintext)", () => {
    const cap = platformMcpRowToCapability(
      row({ envKeys: ["env:GITHUB_TOKEN", "BARE_NAME"] }),
    );

    // Keyed by the var NAME; value is the env:NAME ref. The downstream
    // redactedEnv keeps only the NAMES, so no value ever reaches the DB.
    expect(cap.env).toEqual({
      GITHUB_TOKEN: "env:GITHUB_TOKEN",
      BARE_NAME: "env:BARE_NAME",
    });
  });

  it("carries the row's supportedAgents through", () => {
    const cap = platformMcpRowToCapability(
      row({ supportedAgents: ["claude"] }),
    );

    expect(cap.agents).toEqual(["claude"]);
  });

  it("tags a stdio row with transport=stdio", () => {
    const cap = platformMcpRowToCapability(row({}));

    expect(cap.transport).toBe("stdio");
  });

  it("maps an http row to transport/url/headers, not command (T-C4)", () => {
    const cap = platformMcpRowToCapability(
      row({
        id: "remote",
        transport: "http",
        command: null,
        envKeys: [],
        url: "https://mcp.example.com/sse",
        headerKeys: ["env:MCP_AUTH"],
      }),
    );

    expect(cap.transport).toBe("http");
    expect(cap.url).toBe("https://mcp.example.com/sse");
    expect(cap.headers).toEqual({ MCP_AUTH: "env:MCP_AUTH" });
    expect(cap.command).toBeUndefined();
  });
});
