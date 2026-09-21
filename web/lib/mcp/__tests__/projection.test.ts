import type { PlatformMcpServer } from "@/lib/db/schema";

import { describe, expect, it } from "vitest";

import { platformMcpRowToCapability } from "@/lib/mcp/projection";

function row(overrides: Partial<PlatformMcpServer>): PlatformMcpServer {
  return {
    id: "github",
    transport: "stdio",
    command: "github-mcp",
    args: ["--flag"],
    description: null,
    env: { GITHUB_TOKEN: "env:GITHUB_TOKEN" },
    url: null,
    headers: {},
    bearerTokenEnv: null,
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

  it("passes the stored env map through unchanged, literals included", () => {
    // ADR-177: the row already stores the map, so this projection is identity.
    // A LITERAL survives — it is the operator's declaration that the value is
    // not a secret — while the value behind a REFERENCE stays on the host.
    const cap = platformMcpRowToCapability(
      row({
        env: {
          GITHUB_TOKEN: "env:GITHUB_TOKEN",
          FASTMCP_LOG_LEVEL: "ERROR",
        },
      }),
    );

    expect(cap.env).toEqual({
      GITHUB_TOKEN: "env:GITHUB_TOKEN",
      FASTMCP_LOG_LEVEL: "ERROR",
    });
  });

  it("carries the row's supportedAgents through", () => {
    const cap = platformMcpRowToCapability(
      row({ supportedAgents: ["claude"] }),
    );

    expect(cap.agents).toEqual(["claude"]);
  });

  it("defaults missing supportedAgents to all adapter ids", () => {
    const cap = platformMcpRowToCapability(
      row({
        supportedAgents:
          null as unknown as PlatformMcpServer["supportedAgents"],
      }),
    );

    expect(cap.agents).toEqual([
      "claude",
      "codex",
      "gemini",
      "opencode",
      "mimo",
    ]);
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
        env: {},
        url: "https://mcp.example.com/sse",
        headers: { "X-Api-Key": "env:MCP_AUTH" },
        bearerTokenEnv: "env:MCP_TOKEN",
      }),
    );

    expect(cap.transport).toBe("http");
    expect(cap.url).toBe("https://mcp.example.com/sse");
    expect(cap.headers).toEqual({ "X-Api-Key": "env:MCP_AUTH" });
    expect(cap.bearerTokenEnv).toBe("env:MCP_TOKEN");
    expect(cap.command).toBeUndefined();
  });
});
